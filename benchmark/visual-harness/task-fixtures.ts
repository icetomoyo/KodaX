/** Host-only fixture preparation. Per-run truth is returned separately from public inputs. */
import { Jimp, loadFont } from 'jimp';
import { SANS_16_BLACK, SANS_32_BLACK } from 'jimp/fonts';

const INK = 0x18212bff;
export interface TaskFixture {
  prompt: string;
  files: Record<string, Buffer>;
  images: string[];
  oracle: Record<string, unknown>;
  history?: { text: string; image: string }[];
}

export async function createTaskFixtures(entropy: Buffer): Promise<Record<'A' | 'B' | 'D', TaskFixture>> {
  if (entropy.length !== 4) throw new Error('Freeze exactly four entropy bytes before generation.');
  const font = await loadFont(SANS_16_BLACK);
  const heading = await loadFont(SANS_32_BLACK);
  const image = new Jimp({ width: 1600, height: 1000, color: 0xffffffff });
  const text = (x: number, y: number, value: string) => image.print({ font, x, y, text: value });
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    const length = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
    for (let step = 0; step <= length; step++) {
      const x = Math.round(x1 + (x2 - x1) * step / Math.max(1, length));
      const y = Math.round(y1 + (y2 - y1) * step / Math.max(1, length));
      image.setPixelColor(INK, x, y); image.setPixelColor(INK, x, y + 1);
    }
  };
  const route = (points: [number, number][]) => points.slice(1).forEach((point, i) => line(...points[i]!, ...point));
  image.print({ font: heading, x: 60, y: 40, text: 'Cabinet Q7 / field wiring' });
  text(60, 92, 'Filled dot = electrical junction. Arched bridge = no junction.');
  text(100, 210, 'J2-1'); text(100, 280, 'J2-2'); text(100, 340, 'J2-3'); text(100, 800, 'J2-4');
  route([[180, 220], [510, 220], [510, 170], [1350, 170]]);
  route([[180, 290], [420, 290], [420, 860], [1350, 860]]);
  route([[180, 350], [720, 350], [720, 560], [970, 560], [975, 545], [985, 540], [995, 540], [1005, 545], [1010, 560], [1190, 560], [1190, 720], [1350, 720]]);
  route([[180, 810], [600, 810], [600, 650], [1350, 650]]);
  route([[720, 180], [720, 560]]); text(695, 150, 'TP6');
  route([[990, 240], [990, 530]]); route([[990, 570], [990, 900]]);
  text(1010, 400, 'X7 / spare'); text(740, 330, 'upper'); text(1018, 575, 'lower');
  for (let y = -5; y <= 5; y++) for (let x = -5; x <= 5; x++) {
    if (x * x + y * y <= 25) image.setPixelColor(INK, 720 + x, 350 + y);
  }
  const actuator = ['Valve-A', 'Valve-B', 'Valve-C', 'Valve-D'][entropy[0]! % 4]!;
  const port = ['P2', 'P5', 'P7', 'P9'][entropy[1]! % 4]!;
  text(1365, 705, `${actuator} / ${port}`);
  text(1365, 155, 'Motor-E / P1'); text(1365, 635, 'Relay-F / P4'); text(1365, 845, 'Pump-G / P8');
  const states = [
    { time: '09:10', filter: 'All', visible: true },
    { time: '09:25', filter: entropy[2]! % 2 ? 'Running' : 'Completed', visible: false },
    { time: '10:40', filter: 'Queued', visible: true },
  ];
  const frames: Record<string, Buffer> = {};
  const names = ['before.png', 'after.png', 'latest.png'];
  for (const [index, state] of states.entries()) {
    const frame = new Jimp({ width: 1440, height: 900, color: 0xf7f8faff });
    const label = (x: number, y: number, value: string) => frame.print({ font, x, y, text: value });
    frame.print({ font: heading, x: 50, y: 45, text: `Jobs / console ${index === 0 ? 'v1.8' : 'v1.9'}` });
    label(1120, 55, `Captured ${state.time}`);
    label(50, 130, `Status filter: ${state.filter}`); label(420, 130, 'Owner: All');
    label(50, 215, 'Job ID                 State                 Owner                  Submitted');
    const k17State = state.filter === 'Completed' ? 'Completed' : 'Running';
    const visible = [
      { status: k17State, text: `K17                    ${k17State}               ops                    08:57` },
      { status: 'Queued', text: 'K23                    Queued                batch                  09:02' },
    ].filter(job => state.filter === 'All' || job.status === state.filter);
    visible.forEach((job, row) => label(50, 270 + row * 45, job.text));
    label(50, 370, `Visible rows: ${visible.length}`);
    label(50, 800, 'Queue data refreshed. No jobs deleted.');
    frames[names[index]!] = await frame.getBuffer('image/png');
  }
  return { A: {
    prompt: '沿接线图追踪 J2-3：最终接到哪个执行器和端口？解释标为 upper、lower 的两个交叉位置分别是电气连接还是跨越。给出判断依据。',
    files: { 'wiring.png': await image.getBuffer('image/png') }, images: ['wiring.png'],
    oracle: { actuator, port, upper: 'connected', lower: 'crossing' },
  }, B: {
    prompt: '升级后 K23 为什么不见了？请对照升级前后的面板，指出筛选条件的确切变化、K23 的状态与可见性，并引用对应截图的时刻。最新截图属于稍后的另一轮操作，请区分。',
    files: frames, images: names,
    history: names.map((name, index) => ({ text: `${['升级前面板', '刚升级后的面板', '稍后另一轮操作的面板'][index]}，请保留用于后续排查。`, image: name })),
    oracle: { before: states[0], after: states[1], latest: states[2], target: 'K23', status: 'Queued' },
  }, D: {
    prompt: '修复这个小项目中空配置（包括只有空白的配置）导致的异常，保持有效配置、字段默认值和无效 JSON 的既有行为。运行项目现有测试，说明修复与验证结果。',
    images: [], oracle: { testCommand: 'node --test config.test.mjs', existingTests: 5 },
    files: {
      'package.json': Buffer.from(JSON.stringify({ name: 'queue-config', type: 'module', scripts: { test: 'node --test config.test.mjs' } }, null, 2)),
      'config.mjs': Buffer.from("export function loadConfig(text) {\n  const value = JSON.parse(text);\n  return { retries: value.retries ?? 3, enabled: value.enabled ?? true };\n}\n"),
      'config.test.mjs': Buffer.from("import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { loadConfig } from './config.mjs';\ntest('empty config', () => assert.deepEqual(loadConfig(''), { retries: 3, enabled: true }));\ntest('blank config', () => assert.deepEqual(loadConfig('  \\n\\t'), { retries: 3, enabled: true }));\ntest('valid values', () => assert.deepEqual(loadConfig('{\"retries\":0,\"enabled\":false}'), { retries: 0, enabled: false }));\ntest('field defaults', () => assert.deepEqual(loadConfig('{\"retries\":8}'), { retries: 8, enabled: true }));\ntest('invalid JSON', () => assert.throws(() => loadConfig('{broken'), SyntaxError));\n"),
    },
  } };
}
