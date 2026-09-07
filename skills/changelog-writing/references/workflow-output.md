# Release workflow output

Use only when a workflow consumes the notes or the user requests this machine format. Return one JSON object with these string fields, without a Markdown fence for machine consumers:

```json
{
  "changelog": "<summary and full body as one artifact>",
  "changelog_summary": "<single-line release summary>",
  "changelog_content": "<full release body>"
}
```

Keep the three fields consistent. Choose the language and audience using the skill entry. For a known version, use `Version x.y.z, <main change>` or its equivalent in the selected language; omit the version prefix when no version is known instead of inventing one. Omit a leading `v` in prose unless the channel requires it.

For production, summarize the most important user-visible outcome. For beta/internal notes, summarize the main technical or operational change. Keep raw CI logs out of the body and preserve only verification details useful to the audience.
