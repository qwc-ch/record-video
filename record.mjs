// 交互式录屏：按导航顺序在不同页面间跳转，每页缓慢滚动
import { chromium } from "playwright";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.env.SITE_BASE_URL || "https://blog.amamo.top";
const OUT_DIR = process.env.OUT_DIR || "recordings";
mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORT = { width: 1920, height: 1080 };
// 每个步骤停留时长(秒)，总时长按 TOTAL_SECONDS 缩放
const steps = [
  { name: "home",       path: "/",          weight: 90 },
  { name: "friends",    path: "/friends/",  weight: 60 },
  { name: "timetable",  path: "/timetable/",weight: 60 },
  { name: "analytics",  path: "/analytics/",weight: 60 },
  { name: "circle",     path: "/circle/",   weight: 60 },
  { name: "guestbook",  path: "/guestbook/",weight: 90, closePopup: true },
];
const TOTAL_SECONDS = Number(process.env.TOTAL_SECONDS || 600);
const weightSum = steps.reduce((s, p) => s + p.weight, 0);
for (const p of steps) p.duration = Math.max(10, Math.round((p.weight / weightSum) * TOTAL_SECONDS));
console.log("各步骤时长(s):", steps.map(p => `${p.name}=${p.duration}`).join(", "));

const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});

// 整个流程在一个 context 里录，形成一段完整视频
const context = await browser.newContext({
  viewport: VIEWPORT,
  recordVideo: { dir: OUT_DIR, size: VIEWPORT },
});
const page = await context.newPage();

async function slowScroll(page, durationMs) {
  const start = Date.now();
  // 回到顶部，慢慢滚到底
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await page.waitForTimeout(500);
  const totalH = await page.evaluate(() => document.body.scrollHeight);
  const stepsCount = Math.ceil(totalH / 200);
  const perStep = Math.max(150, Math.floor(durationMs / stepsCount / 1.5));
  for (let y = 0; y < totalH; y += 200) {
    await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: "smooth" }), y);
    await page.waitForTimeout(Math.min(perStep, 1200));
    if (Date.now() - start >= durationMs) break;
  }
}

for (const step of steps) {
  console.log(`\n=== ${step.name} (${step.path}) ${step.duration}s ===`);
  await page.goto(`${BASE_URL}${step.path}`, { waitUntil: "networkidle", timeout: 60000 });

  if (step.closePopup) {
    try {
      const closeBtn = page.locator(".privacy-close");
      await closeBtn.waitFor({ state: "visible", timeout: 10000 });
      await closeBtn.click();
      console.log("已关闭公告弹窗");
      await page.waitForTimeout(1000);
    } catch (e) {
      console.log("未检测到弹窗或关闭失败：", e.message);
    }
  }

  await slowScroll(page, step.duration * 1000);

  // 演示"交互跳转"：在当前页内点击侧边栏里通往下一个页面的链接，
  // 让视频里有真实的点击+跳转动作。最后跳到的页面会在下一轮 goto 兜底。
  const idx = steps.indexOf(step);
  const next = steps[idx + 1];
  if (next) {
    try {
      const link = page.locator(`a[href="${next.path}"]`).first();
      if (await link.count() > 0) {
        await link.click({ timeout: 5000 });
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        console.log(`已通过点击跳转到 ${next.path}`);
        await page.waitForTimeout(1500);
        // 跳过去后稍微停一下，表现"看了一眼"
        await page.waitForTimeout(Math.min(3000, next.duration * 200));
      }
    } catch (e) {
      console.log(`点击跳转失败(忽略): ${e.message}`);
    }
  }
}

const video = page.video();
await context.close();
if (video) {
  const src = await video.path();
  const dest = join(OUT_DIR, "full.webm");
  renameSync(src, dest);
  console.log(`\n已保存 ${dest}`);
}
await browser.close();
console.log("录制完成");
