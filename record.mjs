// 交互式录屏（恒定帧率版）：
// 浏览器以有头模式跑在 Xvfb 虚拟屏幕里，用 ffmpeg x11grab 以固定帧率直接抓屏，
// 输出就是恒定 FPS 的 mp4——不再经过 Playwright 低帧率、可变帧率的 webm 录屏。
// Live2D / WebGL 组件、统计脚本等重渲染资源在网络层拦截，保证滚动流畅。
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.env.SITE_BASE_URL || "https://blog.amamo.top";
const OUT_DIR = process.env.OUT_DIR || "recordings";
const DISPLAY = process.env.DISPLAY || ":99";
const WIDTH = Number(process.env.WIDTH || 1920);
const HEIGHT = Number(process.env.HEIGHT || 1080);
const FPS = Number(process.env.FPS || 30);
mkdirSync(OUT_DIR, { recursive: true });

// 每个页面：路径、时长(秒)。用户要求每页约 1.5 分钟 = 90 秒
const steps = [
  { name: "home",      path: "/",           duration: 90 },
  { name: "friends",   path: "/friends/",   duration: 90 },
  { name: "timetable", path: "/timetable/", duration: 90 },
  { name: "analytics", path: "/analytics/", duration: 90 },
  { name: "circle",    path: "/circle/",    duration: 90 },
  { name: "guestbook", path: "/guestbook/", duration: 90, closePopup: true },
];
console.log("各页面录制时长(s):", steps.map(p => `${p.name}=${p.duration}`).join(", "));

// 拦截 Live2D/WebGL 组件与统计脚本：省 CPU、渲染更快，录出来的滚动更流畅
const BLOCK_RE = /live2d|l2dwidget|spline\.design|googletagmanager|google-analytics|googletag|umami|51\.la|clarity\.ms|cloudflareinsights/i;

// ---------- ffmpeg x11grab 恒定帧率抓屏 ----------
const ffmpeg = spawn("ffmpeg", [
  "-y",
  "-f", "x11grab",
  "-framerate", String(FPS),
  "-video_size", `${WIDTH}x${HEIGHT}`,
  "-i", DISPLAY,
  "-draw_mouse", "1",               // 画面里画出鼠标，点击跳转能看到光标
  "-c:v", "libx264",
  "-preset", "veryfast",
  "-crf", "22",
  "-pix_fmt", "yuv420p",
  join(OUT_DIR, "full.mp4"),
], { stdio: ["pipe", "ignore", "pipe"] });
let errChunks = 0;
ffmpeg.stderr.on("data", (d) => {
  if (errChunks < 40) { process.stderr.write(d); errChunks++; }
});
await new Promise((r) => setTimeout(r, 800));
if (ffmpeg.exitCode !== null) throw new Error("ffmpeg 启动失败，检查 Xvfb 是否已运行");
console.log(`ffmpeg x11grab 已启动: ${DISPLAY} @ 恒定 ${FPS}fps ${WIDTH}x${HEIGHT}`);

// ---------- 浏览器（有头模式，跑在 Xvfb 里） ----------
const browser = await chromium.launch({
  headless: false,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--kiosk",                      // 无浏览器 UI，整屏都是页面
    `--window-size=${WIDTH},${HEIGHT}`,
    "--disable-gpu",
  ],
});
const context = await browser.newContext({ viewport: null }); // 跟随窗口（kiosk 全屏 1920x1080）
await context.route("**/*", (route) => {
  if (BLOCK_RE.test(route.request().url())) return route.abort();
  return route.continue();
});
const page = await context.newPage();

// 在 durationMs 内从顶部匀速线性滚到页面最底部（rAF 驱动，保证划完全页且连续平滑）
// 注意：必须用 behavior:"instant" 瞬时定位，避免站点 CSS 的 scroll-behavior:smooth
// 与逐帧滚动叠加导致 Chrome 把滚动排队动画化，产生偶发抖动
async function scrollFully(page, durationMs) {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(600);
  await page.evaluate((ms) => new Promise((resolve) => {
    const start = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - start) / ms);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({ top: Math.max(0, max) * t, behavior: "instant" });
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  }), durationMs);
  await page.waitForTimeout(800);
}

// 留言页：点掉公告弹窗的叉
// 弹窗是 <dialog>，叉按钮是 .privacy-close；限定 dialog[open] 并取第一个，避免 strict 模式多元素冲突
async function closeAnnouncementPopup(page) {
  const closeBtn = page.locator("dialog[open] .privacy-close").first();
  try {
    await closeBtn.waitFor({ state: "visible", timeout: 15000 });
    await closeBtn.click({ timeout: 5000, force: true });
    await closeBtn.waitFor({ state: "hidden", timeout: 5000 }); // 确认弹窗真的关了
    console.log("已点掉公告弹窗的叉");
    await page.waitForTimeout(1000);
  } catch (e) {
    console.log("弹窗叉未点到(继续录制):", e.message);
  }
}

for (const step of steps) {
  console.log(`\n=== ${step.name} (${step.path}) ${step.duration}s ===`);
  // 上一步如果已经点链接跳过来了，就不重复 goto
  let current = "";
  try { current = new URL(page.url()).pathname; } catch {}
  if (current !== step.path) {
    try {
      await page.goto(`${BASE_URL}${step.path}`, { waitUntil: "networkidle", timeout: 60000 });
    } catch (e) {
      console.log("goto 失败(继续):", e.message);
    }
  }
  if (step.closePopup) await closeAnnouncementPopup(page);
  await scrollFully(page, step.duration * 1000);

  // 交互跳转：点侧边栏里通往下一个页面的链接，让视频里有真实的点击动作
  const next = steps[steps.indexOf(step) + 1];
  if (next) {
    try {
      const link = page.locator(`a[href="${next.path}"]`).first();
      if (await link.count()) {
        await link.scrollIntoViewIfNeeded().catch(() => {});
        await link.click({ timeout: 5000 });
        await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
        console.log(`已点击跳转 → ${next.path}`);
        await page.waitForTimeout(1500);
      }
    } catch (e) {
      console.log(`点击跳转失败(下轮 goto 兜底): ${e.message}`);
    }
  }
}

// ---------- 收尾：关浏览器，优雅停 ffmpeg ----------
await browser.close();
ffmpeg.stdin.write("q");
await new Promise((resolve) => {
  const timer = setTimeout(() => { ffmpeg.kill("SIGKILL"); resolve(); }, 8000);
  ffmpeg.once("exit", () => { clearTimeout(timer); resolve(); });
});
console.log(`\n录制完成: ${join(OUT_DIR, "full.mp4")}`);
