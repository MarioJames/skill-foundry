# Shared by runtime loading, connections, askpass and initialization.
# Input is jq --stream --slurp: inspect keys before constructing objects.
def checked_document:
  . as $events
  | reduce $events[] as $event ({seen: {}, open: {}};
      ($event[0]) as $path
      | if ($event | length) == 2 then
          reduce range(1; ($path | length) + 1) as $depth (.;
            ($path[:$depth] | tojson) as $key
            | if $depth == ($path | length) or (.open[$key] != true) then
                if .seen[$key] then error("invalid configuration") else . end
                | .seen[$key] = true
                | if $depth < ($path | length) then .open[$key] = true else . end
              else . end)
        else
          .open |= with_entries(select((.key | fromjson | length) < (($path | length) - 1)))
        end)
  | [$events | fromstream(.[])]
  | if length == 1 then .[0] else error("invalid configuration") end;
def safe_string($pattern): type == "string" and test($pattern);
def valid_profile:
  type == "object"
  and ((keys - ["user", "host", "port", "identity_file", "password"]) | length == 0)
  and (.user | safe_string("^[A-Za-z0-9_][A-Za-z0-9_.-]*\\z"))
  and (.host | safe_string("^([A-Za-z0-9][A-Za-z0-9.-]*|\\[[0-9A-Fa-f:]+\\]|[0-9A-Fa-f:]*:[0-9A-Fa-f:]+)\\z"))
  and (if has("port") then (.port | type == "number" and floor == . and . >= 1 and . <= 65535) else true end)
  and (if has("identity_file") then (.identity_file | type == "string" and (startswith("/") or startswith("~/")) and (test("[\\x00-\\x1f\\x7f]") | not)) else true end)
  and (if has("password") then (.password | type == "string" and (test("[\\x00\\r\\n]") | not)) else true end);
def validate:
  if type == "object" and keys == ["servers"] and (.servers | type == "object")
     and (.servers | to_entries | all(.key | test("^[a-z][a-z0-9_]*\\z")))
     and (.servers | all(.[]; valid_profile))
  then . else error("invalid configuration") end;
def identity($home):
  (.identity_file // "")
  | if . == "" then "" else
      (if startswith("~/") then $home + .[1:] else . end)
      | split("/") | reduce .[] as $part ([];
          if $part == "" or $part == "." then .
          elif $part == ".." then .[:-1] else . + [$part] end)
      | "/" + join("/")
    end;
def fields($name; $home):
  [$name, .user, .host, ((.port // 22) | floor | tostring), identity($home), ((.password // "") != "" | tostring)];
($ARGS.named.name // "") as $name
| ($ARGS.named.user // "") as $user
| ($ARGS.named.host // "") as $host
| ($ARGS.named.port // "") as $port
| ($ARGS.named.identity // "") as $identity
| ($ARGS.named.home // "") as $home
| checked_document | validate
| if $mode == "validate" then "ok"
  elif $mode == "profiles" then
    ("server-config-v1", (.servers | to_entries[] | .key as $name | .value | fields($name; $home)[]), "end")
  elif $mode == "connect" then
    .servers[$name] | if . == null then error("invalid configuration") else ("server-config-v1", fields($name; $home)[], "end") end
  elif $mode == "askpass" then
    .servers[$name]
    | if . == null then error("invalid configuration") else . end
    | if .user == $user and .host == $host and ((.port // 22) | floor | tostring) == $port
         and identity($home) == $identity and (.password // "") != ""
      then .password else error("invalid configuration") end
  else error("invalid mode") end
