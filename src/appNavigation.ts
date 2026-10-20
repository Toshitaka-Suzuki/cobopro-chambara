export type AppScreen = 'home' | 'play' | 'admin' | 'countdown' | 'game' | 'integrated';
// ゲーム内の場面とは別に、開始手順と管理画面への一時退避を管理する。
export type SessionPhase = 'idle' | 'countdown' | 'playing' | 'settings';

export const SCREEN_HASHES: Record<AppScreen, string> = {
  home: '#/',
  play: '#/play',
  admin: '#/admin',
  countdown: '#/play/countdown',
  game: '#/play/game',
  integrated: '#/play/experience',
};

export const SCREEN_TITLES: Record<AppScreen, string> = {
  home: '画面を選択',
  play: 'プレイの準備',
  admin: '機器の設定',
  countdown: '開始カウントダウン',
  game: 'ゲーム画面',
  integrated: '会話・BGM連携',
};

/** URLのハッシュを画面名へ変換する。空文字・未定義のパスは画面選択として扱う。 */
export function screenFromHash(hash: string): AppScreen {
  return (Object.keys(SCREEN_HASHES) as AppScreen[])
    .find(screen => SCREEN_HASHES[screen] === hash) ?? 'home';
}

/**
 * 遷移先を開始手順の状態と照合し、表示してよい画面を返す。
 * 未準備のカウントダウン・ゲームは準備画面へ置き換える。URL自体は変更しない。
 */
export function resolveScreen(route: AppScreen, phase: SessionPhase): AppScreen {
  if (route === 'countdown' && phase !== 'countdown') return 'play';
  if (route === 'game' && phase !== 'playing') return 'play';
  if (route === 'integrated' && phase !== 'playing') return 'play';
  return route;
}

/**
 * 画面移動後の開始手順の状態を返す。ゲーム内の進行状態は変更しない。
 * 管理画面からの復帰には保存ゲームを要求し、準備・画面選択への移動では終了する。
 */
export function sessionPhaseAfterNavigation(
  screen: AppScreen,
  phase: SessionPhase,
  hasSavedGame: boolean,
): SessionPhase {
  if (screen === 'game' && phase === 'settings' && hasSavedGame) return 'playing';
  if (screen === 'admin' && phase === 'settings') return 'settings';
  if (screen === 'countdown' || screen === 'game' || screen === 'integrated') return phase;
  return 'idle';
}
