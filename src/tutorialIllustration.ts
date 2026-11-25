/** All positions are coordinates on the illustrated stage. */
export const SCENE_WIDTH = 760;
export const SCENE_HEIGHT = 360;
export type TutorialChapter = 'parry' | 'weakness' | 'win' | 'balloon';
type Ctx = CanvasRenderingContext2D;
type Paint = string | CanvasGradient;
type Point = { x: number; y: number };
type Led = 'blue' | 'red' | 'off';
type Lamp = 0 | 1 | 2;

// Fractions of each chapter's running time. The captions and HP use the same
// cue points as the illustration so they also stay in sync when seeking.
export const firstParryAt = .50;
export const firstHitAt = .62;
export const balloonContactAt = .72;
const winRounds = [
  { parryAt: .15, lampAt: .23, hitAt: .40, lampIndex: 2, hpBefore: 2 },
  { parryAt: .60, lampAt: .68, hitAt: .85, lampIndex: 0, hpBefore: 1 },
] as const;
export function winRoundAt(progress: number) {
  return winRounds[progress < .50 ? 0 : 1];
}

const DARK = '#172f33';
const LAMP_X = [111, 175, 239];
const LAMP_Y = 295;
const LAMP_COLORS = ['#ff635e', '#569dff', '#ffcf59'];
const REST = { x: 311, y: 154, angle: -.47 };
const PARRY = { x: 326, y: 156, angle: -.025 };
const REACH = { x: 395, y: 150, angle: .025 };
const WAIT = { x: 508, y: 173, angle: .62 };
const TOUCH = { x: 485, y: 164, angle: .74 };
const CLASH = { x: 455, y: 126, angle: .74 };
const PARK = { x: 521, y: 195, angle: .62 };

function mix(a: number, b: number, amount: number) { return a + (b - a) * amount; }

function slide(t: number, start: number, end: number) {
  const k = Math.max(0, Math.min(1, (t - start) / (end - start)));
  return k * k * (3 - 2 * k);
}

function pose(a: typeof REST, b: typeof REST, amount: number) {
  return { x: mix(a.x, b.x, amount), y: mix(a.y, b.y, amount), angle: mix(a.angle, b.angle, amount) };
}

function path(c: Ctx, data: string, fill?: Paint, stroke?: Paint, weight = 1) {
  const p = new Path2D(data);
  if (fill) { c.fillStyle = fill; c.fill(p); }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = weight; c.stroke(p); }
}

function ellipse(c: Ctx, x: number, y: number, rx: number, ry: number, fill: Paint, stroke?: string, weight = 1) {
  c.beginPath();
  c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  c.fillStyle = fill;
  c.fill();
  if (stroke) { c.lineWidth = weight; c.strokeStyle = stroke; c.stroke(); }
}

function vertical(c: Ctx, top: number, bottom: number, ...colors: string[]) {
  const gradient = c.createLinearGradient(0, top, 0, bottom);
  colors.forEach((color, i) => gradient.addColorStop(i / (colors.length - 1), color));
  return gradient;
}

function halo(c: Ctx, x: number, y: number, size: number, color: string) {
  const glow = c.createRadialGradient(x, y, 2, x, y, size);
  glow.addColorStop(0, color);
  glow.addColorStop(1, color.slice(0, 7) + '00');
  ellipse(c, x, y, size, size, glow);
}

function stage(c: Ctx) {
  const bg = c.createRadialGradient(365, 163, 5, 365, 163, 450);
  bg.addColorStop(0, '#214346');
  bg.addColorStop(.68, '#163437');
  bg.addColorStop(1, '#102a2c');
  c.fillStyle = bg;
  c.fillRect(0, 0, SCENE_WIDTH, SCENE_HEIGHT);
  // Dotted drafting paper gives way to a perspective grid under the props.
  c.fillStyle = '#a0c9b926';
  for (let y = 13; y < 258; y += 18) {
    for (let x = 11; x < SCENE_WIDTH; x += 18) c.fillRect(x, y, 1, 1);
  }
  c.beginPath();
  for (let x = -820; x < 1700; x += 118) {
    c.moveTo(mix(x, 374, .64), 259);
    c.lineTo(x, 360);
  }
  for (const y of [259, 269, 283, 304, 334]) { c.moveTo(0, y); c.lineTo(760, y); }
  c.strokeStyle = '#a4d3c91d';
  c.lineWidth = 1;
  c.stroke();
}

function lamp(c: Ctx, index: number, lit: boolean) {
  const x = LAMP_X[index];
  const color = LAMP_COLORS[index];
  if (lit) halo(c, x, LAMP_Y, 40, color + '99');
  ellipse(c, x, LAMP_Y + 1, 17, 17, '#101f24', '#668481');
  ellipse(c, x, LAMP_Y, 12.8, 12.8, lit ? color : ['#873f40', '#365d87', '#8a743e'][index],
    lit ? '#fffae3' : '#97b5aa5c', lit ? 2 : 1);
  ellipse(c, x - 2, LAMP_Y - 3, 7, 6, lit ? '#ffffff4d' : '#ffffff14');
  if (lit) {
    c.save();
    c.translate(x, LAMP_Y);
    for (const angle of [-2.6, -2.1, -1.52, -.94, -.42]) {
      c.save(); c.rotate(angle);
      path(c, 'M20.5 0H25.5', undefined, color, 2); c.restore();
    }
    c.restore();
  }
}

function pedestal(c: Ctx, active: Lamp | null) {
  ellipse(c, 174, 326, 145, 10, '#071c2187');
  path(c, 'M56 269 76 256H282L266 269Z', '#8b9e9b', '#263e41', 1.5);
  path(c, 'M266 269 282 256V306L266 323Z', '#283f43', '#192e33', 1.5);
  path(c, 'M56 269H266V321Q265 324 261 324H61Q56 324 56 319Z',
    vertical(c, 269, 324, '#54696b', '#384f52'), '#172e31', 1.5);
  path(c, 'M61 272H262M60 319H260', undefined, '#a4b5a978', 1);
  for (const x of [61, 260]) for (const y of [275, 316]) ellipse(c, x, y, 1.4, 1.4, '#193438');
  LAMP_X.forEach((_, i) => lamp(c, i, active === i));
}

// The COBOTTA PRO has a flared foot and a shoulder that sits to one side
// of its base. The three coloured lamps belong to the exhibit plinth.
function robotBase(c: Ctx, shoulder: Point) {
  c.save();
  c.translate(shoulder.x, shoulder.y);
  ellipse(c, 22, 49, 37, 5, '#17363963');
  path(c, 'M-5 22Q-4 30 -10 45Q-11 48 -6 50C6 54 31 54 47 49Q50 48 49 44L45 22Z',
    vertical(c, 20, 53, '#d4dcda', '#f2f2e9', '#b7c4c4'), DARK, 1.4);
  path(c, 'M3 49 4 41Q5 38 9 39L11 50 M40 48 39 40Q40 38 43 38L45 47',
    '#aab7b8', '#99a8aa', .7);
  for (const x of [7, 42]) ellipse(c, x, 47, 1.25, .85, '#65767b');
  path(c, 'M-5 22C-5 13 -11 7 -13 -2C-17 -18 -9 -32 5 -36C20 -41 35 -34 41 -21C46 -12 46 0 46 19Q46 24 40 26Q17 33 -4 26Z',
    vertical(c, -38, 28, '#f4f5ef', '#e7ece8', '#b3c1c2'), DARK, 1.45);
  path(c, 'M23 -36Q35 -34 40 -24', undefined, '#b4d8b5', 1.8);
  path(c, 'M-3 25Q20 32 44 23', undefined, '#879699', .8);
  c.restore();
}

const armOutline = '#415255';
const coverSeam = '#98a6a7';

function armFrame(c: Ctx, from: Point, to: Point) {
  c.translate(from.x, from.y);
  c.rotate(Math.atan2(to.y - from.y, to.x - from.x));
  return Math.hypot(to.x - from.x, to.y - from.y);
}

// The end covers are almost flush with the housing. Only the seam and
// the small recessed fasteners are visible in the product photograph.
function endCover(c: Ctx, x: number, y: number, rx: number, ry: number, tilt: number) {
  c.save();
  c.translate(x, y);
  c.rotate(tilt);
  ellipse(c, 0, 0, rx, ry, vertical(c, -ry, ry, '#f0f2ed', '#e2e7e5', '#cbd4d3'), coverSeam, .7);
  for (const a of [-1.45, .63, 2.72]) {
    ellipse(c, rx * .68 * Math.cos(a), ry * .73 * Math.sin(a), 1.05, .95, '#687678');
  }
  c.restore();
}

function upperArm(c: Ctx, shoulder: Point, elbow: Point) {
  c.save();
  const n = armFrame(c, shoulder, elbow);
  path(c, `M-20 -5C-20 -19 -7 -25 8 -23C26 -21 36 -16 58 -16
    L${n - 30} -15Q${n - 13} -15 ${n - 4} -17Q${n + 13} -19 ${n + 16} -3
    Q${n + 18} 12 ${n + 4} 17C${n - 12} 20 ${n - 26} 15 ${n - 44} 15
    L47 16C30 17 21 22 8 23C-9 24 -21 13 -20 -5Z`,
    vertical(c, -24, 24, '#c3cecf', '#e7ece9', '#f6f6ee', '#d3dcdb'), armOutline, 1.45);
  path(c, `M18 14Q36 9 60 10L${n - 31} 9`, undefined, '#fafaf28c', 1.5);
  endCover(c, -.3, -.5, 21, 16, -.14);
  c.restore();
}

function forearm(c: Ctx, elbow: Point, wrist: Point) {
  c.save();
  const n = armFrame(c, elbow, wrist);
  path(c, `M-21 -2C-22 -14 -15 -23 -2 -23C13 -23 26 -18 41 -15
    C60 -12 77 -13 ${n - 17} -12Q${n + 8} -15 ${n + 12} -3
    Q${n + 17} 12 ${n + 2} 15Q${n - 8} 16 ${n - 22} 13L59 13
    C38 13 28 16 14 19C-3 25 -20 18 -21 -2Z`,
    vertical(c, -23, 22, '#f9f9f2', '#edf1ee', '#dde5e3', '#b6c4c6'), armOutline, 1.45);
  endCover(c, -.7, -.8, 15.9, 18.8, -.27);
  path(c, 'M38 -15Q44 -2 38 14', undefined, coverSeam, .75);
  path(c, `M${n - 17} -11Q${n - 22} 0 ${n - 17} 13`, undefined, coverSeam, .7);
  path(c, `M49 -9Q78 -10 ${n - 30} -9`, undefined, '#fffff694', 1.25);
  for (const x of [58, n - 34]) {
    path(c, `M${x} -9l.6 1.6M${x} 9l.6 1.5`, undefined, '#7f9091', .85);
  }
  c.fillStyle = '#475358';
  c.font = 'italic bold 10px Helvetica, Arial, sans-serif';
  c.textAlign = 'center';
  c.fillText('DENSO', n * .56, 3.5);
  c.restore();
}

// The wrist rolls into a silver collar and a short dark tool flange.
// A separate small clamp on that flange holds the exhibit's foam sword.
function robotWrist(c: Ctx, wrist: Point, grip: Point) {
  c.save();
  const n = armFrame(c, wrist, grip);
  path(c, 'M-11 -9C-8 -16 0 -19 7 -17Q17 -16 21 -12L28 -10 28 10 21 12C13 13 9 16 3 16C-10 16 -17 2 -11 -9Z',
    vertical(c, -18, 17, '#f7f7ef', '#e2e8e6', '#bfcacc'), armOutline, 1.2);
  path(c, 'M9 -16C4 -15 -3 -10 -4 -1Q-6 10 3 15M23 -11Q18 -1 22 11',
    undefined, '#91a0a3', .85);
  ellipse(c, 6, -9, 1.55, 1.15, '#7d898b');
  path(c, 'M25 -11Q29 -12 32 -10V10Q28 12 24 11Q20 1 25 -11Z',
    vertical(c, -11, 11, '#e0e6e5', '#b6c1c0', '#869695'), '#748284', .8);
  path(c, 'M31 -10Q33 -11 36 -10L45 -9Q48 -7 48 -1V5L44 9H34Q29 7 29 1Q28 -6 31 -10Z',
    vertical(c, -11, 10, '#61706d', '#47544f', '#303b3a'), '#253433', 1);
  ellipse(c, 40, 1, 2.5, 2.1, '#303c3d', '#82908b', .7);
  path(c, `M45 -6L${n - 3} -6 ${n + 1} -1 ${n - 3} 5 44 6Z`, '#707e79', DARK, 1);
  c.restore();
}

function robotSword(c: Ctx, grip: typeof REST, led: Led) {
  c.save();
  c.translate(grip.x, grip.y);
  c.rotate(grip.angle);
  path(c, 'M-17 -6Q-20 -6 -20 0Q-20 6 -17 6H24V-6Z', '#536668', '#132829', 1.4);
  path(c, 'M13 -12Q13 -15 16 -15H21Q23 -15 23 -12V12Q23 15 20 15H16Q13 15 13 12Z',
    '#bdc9bb', DARK, 1.5);
  const blade = 'M21 -10.5Q21 -13 27 -13L197 -11Q209 -11 209 0Q209 10.5 197 11L27 13Q21 13 21 10Z';
  c.save();
  if (led !== 'off') {
    c.shadowColor = led === 'blue' ? '#479bffc4' : '#ff5559c4';
    c.shadowBlur = 12;
  }
  path(c, blade, vertical(c, -13, 13, '#fbfae9', '#fffef4', '#e5e3d7', '#b4bdb4'), '#b4beb5', 1.2);
  c.restore();
  c.save();
  c.clip(new Path2D(blade));
  const coil = new Path2D();
  for (let x = 18; x <= 215; x += 24) {
    coil.moveTo(x, -15);
    coil.bezierCurveTo(x + 14, -5, x + 13, 6, x + 16, 14.5);
  }
  c.lineWidth = 5.3;
  c.strokeStyle = led === 'off' ? '#a2b0ac' : led === 'blue' ? '#245aa7' : '#af2e38';
  c.stroke(coil);
  if (led !== 'off') {
    c.shadowColor = led === 'blue' ? '#327bff' : '#ff414b';
    c.shadowBlur = 8;
    c.lineWidth = 3.7;
    c.strokeStyle = led === 'blue' ? '#54b2ff' : '#ff6865';
    c.stroke(coil);
    c.shadowBlur = 0;
    c.lineWidth = 1;
    c.strokeStyle = led === 'blue' ? '#9ddbff' : '#ffb69a';
    c.stroke(coil);
  }
  c.restore();
  path(c, 'M-11 -14 -4 -13 4 -8 9 -9 10 -5 3 -3 -6 -7 -13 -6Z M-12 6 -5 7 4 4 10 5 8 10 2 9 -5 14 -12 14Z',
    '#a4afb0', '#233b3d', 1.1);
  c.restore();
}

function robotArm(c: Ctx, grip: typeof REST, led: Led) {
  const shoulder = { x: 192, y: 213 };
  const wristAngle = .98 + grip.angle * .16;
  const wrist = { x: grip.x - 56 * Math.cos(wristAngle), y: grip.y - 56 * Math.sin(wristAngle) };

  // Find the upper of the two possible elbows for this illustrated pose.
  // Both moulded arm sections keep their length throughout the swing.
  const upperLength = 148, forearmLength = 150;
  const dx = wrist.x - shoulder.x, dy = wrist.y - shoulder.y;
  const distance = Math.hypot(dx, dy);
  const along = (upperLength ** 2 - forearmLength ** 2 + distance ** 2) / (2 * distance);
  const across = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
  const elbow = {
    x: shoulder.x + (along * dx + across * dy) / distance,
    y: shoulder.y + (along * dy - across * dx) / distance,
  };
  robotBase(c, shoulder);
  upperArm(c, shoulder, elbow);
  forearm(c, elbow, wrist);
  robotWrist(c, wrist, grip);
  robotSword(c, grip, led);
}

function playerSword(c: Ctx, tip: typeof WAIT) {
  c.save();
  c.translate(tip.x, tip.y);
  c.rotate(tip.angle);
  // The player's rounded foam blade stays plain orange so only the robot's blade signals a parry.
  path(c, 'M0 0Q0 -8 8 -9L163 -11Q168 -11 169 -7V7Q168 11 163 11L8 9Q0 8 0 0Z',
    vertical(c, -11, 11, '#ffce88', '#eea15e', '#db7548'), '#462f2b', 1.6);
  path(c, 'M10 -5Q78 -7 157 -7', undefined, '#ffe5aa', 1.7);
  path(c, 'M15 6 155 7', undefined, '#b26742', 1);
  path(c, 'M156 -10H160V10H156Z', '#fff0c1');
  path(c, 'M168 -15Q167 -18 173 -17L178 -15V15L172 17Q168 18 168 14Z',
    '#3a4b4a', '#1c3031', 1.3);
  path(c, 'M177 -5H213Q219 -4 219 0Q219 5 213 5H177Z', '#585b50', '#192b2c', 1.4);
  // A cuff and a gloved hand mark this as the player's sword, including in the close-up of the lamps.
  path(c, 'M199 7Q210 5 218 3L245 9 242 23 210 20 201 16Z',
    vertical(c, 3, 24, '#577a78', '#375652'), '#203d3d', 1.4);
  path(c, 'M181 -4Q183 -10 187 -8L192 -11Q195 -12 197 -9Q203 -13 206 -8Q213 -9 213 -4L209 7Q208 13 201 15L188 14Q182 14 179 10L175 5Q173 1 176 -1Q178 -3 183 1Z',
    '#c7bc96', '#584f41', 1.2);
  path(c, 'M185 -5 189 0M193 -7 196 -2M200 -7 202 -3M177 2 184 7', undefined, '#7d745e', 1.2);
  c.restore();
}

function balloon(c: Ctx, touched: boolean) {
  const x = 642, y = 156;
  ellipse(c, x + 3, 302, 31, 5, '#071c2182');
  path(c, 'M622 299 631 294 653 294 664 299 663 302H623Z', '#637d76', DARK, 1.2);
  path(c, 'M641 299 640 201 644 201 645 299Z', '#8d9b89', '#213b3b');
  c.save();
  c.translate(x, y);
  if (touched) { c.translate(1.5, 0); c.scale(.96, 1.01); }
  const shell = 'M0 -43 C18 -44 37 -26 40 -6 Q46 22 17 39L4 43H-4Q-39 33 -41 4Q-45 -22 -17 -39Z';
  path(c, shell, '#e6c778', '#113536', 2);
  c.save();
  c.clip(new Path2D(shell));
  path(c, 'M-4 -44Q-32 -23 -32 2Q-30 28 -3 44L-15 47 -52 17 -51 -21 -26 -46Z', '#6baf9f');
  path(c, 'M0 -43Q-11 -18 -9 5Q-7 30 1 44Q-22 34 -23 5Q-25 -23 0 -43Z', '#e39972');
  path(c, 'M1 -44Q23 -31 26 -4Q29 28 1 43Q15 20 12 -3Q12 -28 1 -44Z', '#91b5a4');
  path(c, 'M4 -44Q36 -29 39 -5Q40 17 23 34L38 32 50 10 44 -27Z', '#c98066');
  path(c, 'M-42 -4Q-5 5 40 -5M-36 18Q-8 25 35 17M-28 -27Q1 -20 28 -25', undefined, '#715e4e45', .9);
  path(c, 'M-9 -39Q-21 -21 -21 -9', undefined, '#fff5cfb3', 1.8);
  c.restore();
  path(c, 'M-3 41 -5 46 6 46 3 41Z', '#d6bda1', '#584f42');
  c.restore();
}

function impact(c: Ctx, x: number, y: number, color: string) {
  c.save();
  c.translate(x, y);
  for (const a of [-2.35, -1.65, -.92, .36, 1.12, 2.44]) {
    c.save(); c.rotate(a);
    path(c, 'M13.5 -.8 24 -1.5 22 .7 13.5 .7Z', color);
    c.restore();
  }
  c.restore();
}

export function drawTutorialScene(canvas: HTMLCanvasElement, chapter: TutorialChapter, progress: number) {
  const c = canvas.getContext('2d');
  if (!c) return;
  const t = Math.min(1, Math.max(0, progress));
  c.setTransform(canvas.width / SCENE_WIDTH, 0, 0, canvas.height / SCENE_HEIGHT, 0, 0);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  let grip = REST;
  let player = WAIT;
  let led: Led = 'off';
  let active: Lamp | null = null;
  let contact: Point | null = null;
  let contactColor = '#fff4be';
  let balloonHit = false;
  if (chapter === 'parry') {
    grip = pose(REST, PARRY, slide(t, .27, firstParryAt));
    player = pose(WAIT, TOUCH, slide(t, .34, firstParryAt));
    player = pose(player, CLASH, slide(t, firstParryAt, .58));
    led = t < firstParryAt ? 'blue' : 'red';
    if (t >= firstParryAt) contact = { x: 485, y: 153 };
  } else if (chapter === 'weakness') {
    active = 1;
    grip = pose(PARRY, REST, slide(t, 0, .21));
    const target = { x: LAMP_X[active] + 4, y: LAMP_Y - 2, angle: -.23 };
    player = pose(CLASH, target, slide(t, .28, firstHitAt));
    if (t >= firstHitAt) { contact = { x: LAMP_X[active], y: LAMP_Y }; contactColor = LAMP_COLORS[active]; }
  } else if (chapter === 'win') {
    const { parryAt, lampAt, hitAt, lampIndex } = winRoundAt(t);
    const target = { x: LAMP_X[lampIndex] + 4, y: LAMP_Y - 2, angle: -.23 };
    grip = pose(REST, PARRY, slide(t, parryAt - .07, parryAt) * (1 - slide(t, lampAt, lampAt + .04)));
    player = pose(WAIT, TOUCH, slide(t, parryAt - .07, parryAt));
    player = pose(player, CLASH, slide(t, parryAt, parryAt + .02));
    player = pose(player, target, slide(t, hitAt - .12, hitAt));
    led = t < parryAt ? 'blue' : t < lampAt ? 'red' : 'off';
    if (t >= parryAt && t < lampAt) contact = { x: 485, y: 153 };
    if (t >= lampAt) active = lampIndex;
    if (t >= hitAt) { contact = { x: LAMP_X[lampIndex], y: LAMP_Y }; contactColor = LAMP_COLORS[lampIndex]; }
  } else {
    grip = pose(REST, REACH, slide(t, .26, balloonContactAt));
    player = pose(PARK, { x: 587, y: 233, angle: .40 }, slide(t, .16, .4));
    led = t < .48 ? 'blue' : 'red';
    balloonHit = t >= balloonContactAt;
    if (balloonHit) contact = { x: 603, y: 155 };
  }
  stage(c);
  balloon(c, balloonHit);
  pedestal(c, active);
  robotArm(c, grip, led);
  playerSword(c, player);
  if (contact) impact(c, contact.x, contact.y, contactColor);
}
