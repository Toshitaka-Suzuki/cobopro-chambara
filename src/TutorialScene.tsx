import { useLayoutEffect, useRef } from 'react';
import { drawTutorialScene, SCENE_HEIGHT, SCENE_WIDTH } from './tutorialIllustration';
import type { TutorialChapter } from './tutorialIllustration';

export function TutorialScene({ chapter, progress }: { chapter: TutorialChapter; progress: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frame = useRef({ chapter, progress });

  useLayoutEffect(() => {
    frame.current = { chapter, progress };
    if (canvasRef.current) drawTutorialScene(canvasRef.current, chapter, progress);
  }, [chapter, progress]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const scale = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(canvas.clientWidth * scale));
      const height = Math.max(1, Math.round(width * SCENE_HEIGHT / SCENE_WIDTH));
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      drawTutorialScene(canvas, frame.current.chapter, frame.current.progress);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  return <canvas ref={canvasRef} width={SCENE_WIDTH} height={SCENE_HEIGHT} aria-hidden="true"
    style={{ display: 'block', width: '100%', height: 'auto', aspectRatio: `${SCENE_WIDTH} / ${SCENE_HEIGHT}` }} />;
}
