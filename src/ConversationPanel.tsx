import { useEffect, useRef, useState } from 'react';
import type { ConversationProgress, ConversationProgressReason } from './integratedSession';

const RETRY_MESSAGES: Record<ConversationProgressReason, string> = {
  no_speech: '声が聞こえませんでした。もう一度話してください。',
  empty_transcript: 'うまく聞き取れませんでした。もう一度話してください。',
  recording_failed: 'マイクの音を確認できませんでした。もう一度試します。',
  recognition_failed: '言葉を聞き取れませんでした。もう一度話してください。',
  reply_failed: '返答を作れませんでした。もう一度話してください。',
  speech_failed: '音声を再生できませんでした。画面の言葉をご確認ください。',
};

export function ConversationPanel({ progress, complete = false }: {
  progress: ConversationProgress;
  complete?: boolean;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [now, setNow] = useState(() => performance.now());
  const waiting = !complete && (progress.stage === 'thinking' || progress.stage === 'recognizing');
  const lastMessage = progress.messages.at(-1);

  useEffect(() => {
    if (!waiting) return;
    setNow(performance.now());
    const timer = window.setInterval(() => setNow(performance.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [waiting, progress.startedAt]);

  useEffect(() => {
    const log = logRef.current;
    if (log && followLatest.current) log.scrollTop = log.scrollHeight;
  }, [lastMessage?.id, progress.stage]);

  const elapsed = Math.max(0, Math.floor((now - progress.startedAt) / 1_000));
  const thinking = !complete && progress.stage === 'thinking';
  const status = complete ? '会話が終わりました' : {
    question: 'ロボットが質問しています',
    preparing: 'マイクを準備しています',
    listening: '話してください',
    recognizing: '言葉を聞き取っています',
    thinking: '返答を考えています',
    speaking: 'ロボットが話しています',
    retry: progress.reason === 'speech_failed' ? '音声を再生できませんでした' : 'もう一度、聞かせてください',
  }[progress.stage];
  const hint = complete ? '感想を聞かせてくれて、ありがとう。' : {
    question: '質問が終わり、「話してください」と表示されたら話しかけてください。',
    preparing: '準備ができるまで、少しお待ちください。',
    listening: 'マイクに向かって話してください。話し終えると自動で進みます。',
    recognizing: '聞き取れた言葉が、この画面に表示されます。',
    thinking: elapsed >= 15 ? '返答に少し時間がかかっています。このままお待ちください。'
      : '返答ができたら、声と文字でお伝えします。',
    speaking: '返答を読み上げています。',
    retry: RETRY_MESSAGES[progress.reason ?? 'empty_transcript'],
  }[progress.stage];

  return <section className="conversation-panel" aria-label="ロボットとの会話">
    <div className="conversation-state" data-stage={complete ? 'complete' : progress.stage}>
      <div className="conversation-status" role="status">
        <span className="conversation-state-dot" aria-hidden="true" />
        <strong>{status}</strong>
      </div>
      {waiting && <span className="conversation-elapsed" aria-hidden="true">{elapsed}秒経過</span>}
    </div>
    <p className="conversation-hint">{hint}</p>
    <div className="conversation-log" ref={logRef} role="log" aria-label="会話内容"
      aria-live="polite" aria-relevant="additions" tabIndex={0}
      onScroll={() => {
        const log = logRef.current;
        if (log) followLatest.current = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      }}>
      <ol className="conversation-messages">
        {progress.messages.map(message => <li key={message.id} className={`conversation-message is-${message.role}`}>
          <span className="conversation-speaker">{message.role === 'user' ? 'あなた · 聞き取った言葉' : 'ロボット'}</span>
          <p className="conversation-bubble">{message.text}</p>
        </li>)}
      </ol>
      {thinking && <div className="conversation-pending" aria-hidden="true">
        <span className="conversation-speaker">ロボット</span>
        <div className="conversation-bubble conversation-typing"><span /><span /><span /></div>
      </div>}
    </div>
  </section>;
}
