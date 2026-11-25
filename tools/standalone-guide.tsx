import { createRoot } from 'react-dom/client';
import '../src/style.css';
import { GameGuide } from '../src/GameGuide';

createRoot(document.getElementById('root')!).render(<GameGuide showAppLinks={false} />);
