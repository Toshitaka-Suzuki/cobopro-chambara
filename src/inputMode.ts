export type InputMode = 'mock' | 'sensor';

export const INPUT_MODE_LABELS: Record<InputMode, string> = {
  mock: 'ゲームテスト（モック）',
  sensor: 'センサ接続（実機）',
};
