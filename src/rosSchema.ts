import type { RosTypeDef } from './ros';

export const MAX_ROS_REQUEST_CHARACTERS = 65_536;

const TEMPLATE_VALUE_BUDGET = 1_000;
const TEMPLATE_MAX_DEPTH = 8;
const TEMPLATE_MAX_ARRAY_LENGTH = 32;

export type RosRequestTemplate = { text: string; complete: boolean };

/**
 * rosapi の型定義から編集用の JSON 雛形を返す。先頭要素を要求の型、後続を入れ子の型として扱う。
 * 定義不足・再帰・生成量の上限で省略した箇所は空の値にし、complete を false にする。
 */
export function createRosRequestTemplate(definitions: RosTypeDef[] | null): RosRequestTemplate {
  if (!definitions?.length) return { text: '{}', complete: false };
  let complete = true;
  // 外部の型定義が再帰や巨大配列を含んでも、画面を占有しない範囲で雛形を作る。
  let remainingValues = TEMPLATE_VALUE_BUDGET;
  const normalizeTypeName = (type: string) => type.replace(/\/(msg|srv)\//, '/');
  const byType = new Map(definitions.map(definition => [normalizeTypeName(definition.type), definition]));
  const fieldValue = (type: string, path: Set<string>): unknown => {
    if (--remainingValues < 0 || path.size > TEMPLATE_MAX_DEPTH) { complete = false; return {}; }
    if (type === 'bool' || type === 'boolean') return false;
    if (/^(w?string)(<=\d+)?$/.test(type)) return '';
    if (/^(u?int(8|16|32|64)|float(32|64)?|double|byte|char|octet)$/.test(type)) return 0;
    const key = normalizeTypeName(type);
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
      if (length > TEMPLATE_MAX_ARRAY_LENGTH) { complete = false; return [name, []]; }
      return [name, length > 0
        ? Array.from({ length }, () => fieldValue(fieldType, nextPath))
        : fieldValue(fieldType, nextPath)];
    }));
  };
  return { text: JSON.stringify(fieldValue(definitions[0].type, new Set()), null, 2), complete };
}

/**
 * 文字数上限内の JSON オブジェクトを解析して返す。上限超過・不正 JSON・配列やプリミティブは例外にする。
 * 画面と送信処理で共用する形式検証であり、ROS の型定義との一致までは検証しない。
 */
export function parseRosRequest(text: string): Record<string, unknown> {
  if (text.length > MAX_ROS_REQUEST_CHARACTERS) {
    throw new Error('リクエストは65,536文字以内で入力してください。');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('JSONの書式を確認してください。キーはダブルクォートで囲みます。');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('リクエストはJSONオブジェクト（例：{}）で入力してください。');
  }
  return value as Record<string, unknown>;
}

/** 送信時と同じ形式検証を行い、問題がなければ null、不正なら画面表示用のエラーメッセージを返す。 */
export function validateRosRequest(text: string): string | null {
  try {
    parseRosRequest(text);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
