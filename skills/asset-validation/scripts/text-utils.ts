export function textLength(value: string): number {
  return Array.from(value).length;
}

export function takeCodePoints(value: string, count: number): string {
  return Array.from(value).slice(0, count).join("");
}
