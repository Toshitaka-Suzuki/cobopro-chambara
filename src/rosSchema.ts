import type { RosTypeDef } from './ros';

export type RosRequestTemplate = { text: string; complete: boolean };

/** rosapi returns the requested type first, followed by the nested message types. */
export function createRosRequestTemplate(definitions: RosTypeDef[] | null): RosRequestTemplate {
  if (!definitions?.length) return { text: '{}', complete: false };
  let complete = true;
  let budget = 1_000;
  const canonical = (type: string) => type.replace(/\/(msg|srv)\//, '/');
  const byType = new Map(definitions.map(definition => [canonical(definition.type), definition]));
  const fieldValue = (type: string, path: Set<string>): unknown => {
    if (--budget < 0 || path.size > 8) { complete = false; return {}; }
    if (type === 'bool' || type === 'boolean') return false;
    if (/^(w?string)(<=\d+)?$/.test(type)) return '';
    if (/^(u?int(8|16|32|64)|float(32|64)?|double|byte|char|octet)$/.test(type)) return 0;
    const key = canonical(type);
    const definition = byType.get(key);
    if (!definition || path.has(key)) { complete = false; return {}; }
    const nextPath = new Set(path).add(key);
    return Object.fromEntries(definition.fieldnames.map((name, index) => {
      const fieldType = definition.fieldtypes[index];
      const length = definition.fieldarraylen[index];
      if (typeof fieldType !== 'string' || !Number.isInteger(length) || length < -1) {
        complete = false;
        return [name, {}];
      }
      if (length === 0) return [name, []];
      if (length > 32) { complete = false; return [name, []]; }
      return [name, length > 0
        ? Array.from({ length }, () => fieldValue(fieldType, nextPath))
        : fieldValue(fieldType, nextPath)];
    }));
  };
  return { text: JSON.stringify(fieldValue(definitions[0].type, new Set()), null, 2), complete };
}

export function validateRosRequest(text: string): string | null {
  if (text.length > 65536) return 'リクエストは65,536文字以内で入力してください。';
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return 'リクエストはJSONオブジェクト（例：{}）で入力してください。';
    }
    return null;
  } catch {
    return 'JSONの書式を確認してください。キーはダブルクォートで囲みます。';
  }
}
