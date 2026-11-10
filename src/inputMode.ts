export type InputMode = 'mock' | 'sensor' | 'esp';

export const INPUT_MODE_LABELS: Record<InputMode, string> = {
  mock: 'ゲームテスト（モック）',
  sensor: 'センサ接続（実機）',
  esp: 'ESP連携（既存仕様）',
};
