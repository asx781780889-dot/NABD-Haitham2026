"""Browser smoke test (Playwright for Python). Needs: node tests/helpers/ui-server.js running (fake Telegram + fake AI, fresh database!), then: python3 tests/ui/ui_smoke.py
Walks the onboarding wizard in Arabic, adds an account, syncs sources, injects Telegram messages, exercises the live feed, visits every route and checks desktop/mobile/EN/light for console errors. Screenshots go to /tmp/shots."""
import json, sys, time, re, urllib.request, os
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:18090"; CTL = "http://127.0.0.1:18091"
def ctl(path, body=None):
    req = urllib.request.Request(CTL + path, data=json.dumps(body or {}).encode(), headers={"content-type": "application/json"}, method="POST" if body is not None else "GET")
    return json.loads(urllib.request.urlopen(req).read())
info = ctl("/info")
HUB = -1001111111111
ctl("/add-account", {"phone": "+966500000001", "userId": 7001, "username": "acc_one", "dialogs": [
    {"chatId": HUB, "kind": "supergroup", "title": "Students Hub", "username": None, "members": 500},
    {"chatId": -1003333333333, "kind": "channel", "title": "News", "username": "newsch", "members": 9000}]})

os.makedirs('/tmp/shots', exist_ok=True)
errors = []
PAGE = {}
def dump(exc_type, exc, tb):
    print('FAILED:', exc)
    try:
        pg = PAGE['p']; pg.screenshot(path='/tmp/shots/fail.png'); print('--- page text ---'); print(pg.locator('body').inner_text()[:700])
    except Exception as e: print('dump failed', e)
    for e in errors: print('  ', e)

def hook(page, label):
    page.on("pageerror", lambda e: errors.append(f"[{label}] pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"[{label}] console.{m.type}: {m.text}") if m.type in ("error",) else None)
    page.on("requestfailed", lambda r: errors.append(f"[{label}] requestfailed: {r.url} {r.failure}"))
    page.on("response", lambda r: errors.append(f"[{label}] HTTP {r.status} {r.url}") if r.status >= 400 and "/api/" in r.url and r.status not in (401,) else None)

import traceback
def run(p):
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1366, "height": 860}, locale="ar-SA")
        page = ctx.new_page(); hook(page, "wizard"); PAGE["p"] = page
        page.goto(BASE); page.wait_for_selector("text=إنشاء حساب المدير", timeout=15000)
        page.screenshot(path="/tmp/shots/01-wizard-admin-ar.png")
        inputs = page.locator("input")
        inputs.nth(0).fill("admin"); inputs.nth(1).fill("Passw0rd-Strong1"); inputs.nth(2).fill("Passw0rd-Strong1")
        page.get_by_role("button", name="التالي").click()
        page.wait_for_selector("text=فحص قاعدة البيانات"); page.wait_for_selector("text=PostgreSQL")
        page.get_by_role("button", name="التالي").click(); page.wait_for_selector("text=فحص Redis"); page.wait_for_selector("text=Redis >> nth=1")
        page.get_by_role("button", name="التالي").click(); page.wait_for_selector("text=مزود الذكاء الاصطناعي")
        page.locator("select").select_option("custom")
        fields = page.locator(".card input")
        page.locator("#f-api_key").fill("k"); page.locator("#f-model").fill("fake-model"); page.locator("#f-base_url").fill(info["ai"])
        page.get_by_role("button", name="حفظ + اختبار").click(); page.wait_for_selector("text=المزود يعمل", timeout=15000)
        page.screenshot(path="/tmp/shots/02-wizard-ai-ar.png")
        page.get_by_role("button", name="التالي").click(); page.wait_for_selector("text=إعداد Telegram")
        page.get_by_role("button", name="إضافة حساب").click(); page.wait_for_selector(".modal")
        page.locator("#f-phone").fill("+966500000001"); page.locator("#f-api_id").fill("12345"); page.locator("#f-api_hash").fill("a" * 32)
        page.screenshot(path="/tmp/shots/03-add-account-ar.png")
        page.locator(".modal").get_by_role("button", name="التالي").click(); page.wait_for_selector("text=أدخل الكود", timeout=15000)
        page.locator("#f-code").fill("12345"); page.locator(".modal").get_by_role("button", name="تحقق").click(); page.wait_for_selector("text=تم ربط الحساب بنجاح", timeout=15000)
        page.locator(".modal").get_by_role("button", name="تم").click()
        page.get_by_role("button", name="التالي").click(); page.wait_for_selector("text=أنشئ أول قاعدة")
        page.get_by_role("button", name="رادار جديد").click(); page.wait_for_selector(".modal textarea")
        page.locator(".modal textarea").fill("أريد الأشخاص الذين يكتبون أنهم يحتاجون مساعدة في مشاريع التخرج")
        page.locator(".modal").get_by_role("button", name="توليد").click(); page.wait_for_selector("text=راجع القاعدة المُولَّدة", timeout=20000)
        page.screenshot(path="/tmp/shots/04-radar-draft-ar.png")
        page.locator(".modal").get_by_role("button", name="تأكيد وتفعيل").click(); page.wait_for_selector(".modal", state="detached", timeout=10000)
        page.get_by_role("button", name="التالي").click(); page.wait_for_selector("text=تشغيل العمّال")
        pass
        page.wait_for_timeout(1500); page.screenshot(path="/tmp/shots/05-wizard-ready-ar.png")
        page.get_by_role("button", name="اذهب إلى لوحة التحكم").click()
        page.wait_for_selector(".kpi", timeout=15000); page.wait_for_timeout(1200)
        page.screenshot(path="/tmp/shots/06-dashboard-ar.png")
        print("wizard+dashboard OK; errors so far:", len(errors))
        for e in errors: print("  ", e)
        errors.clear()

        # accounts -> sync -> sources -> enable monitoring
        page.goto(BASE + "/#/accounts"); page.wait_for_selector("table"); page.get_by_title("مزامنة").first.click(); page.wait_for_selector(".toast", timeout=25000); page.wait_for_timeout(800)
        page.screenshot(path="/tmp/shots/07-accounts-ar.png")
        page.goto(BASE + "/#/sources"); page.wait_for_selector("table tbody tr"); 
        for sw in page.locator("table tbody .switch input").all(): sw.check()
        page.wait_for_timeout(800); page.screenshot(path="/tmp/shots/08-sources-ar.png")

        # live feed with injected messages
        page.goto(BASE + "/#/feed"); page.wait_for_selector(".filters"); page.wait_for_timeout(600)
        for i, text in enumerate(["السلام عليكم احتاج مساعدة في مشروع التخرج", "مين يقدر يساعدني بمشروع التخرج", "ابي احد يساعدني في مشروع التخرج لو سمحتم"]):
            ctl("/deliver", {"phone": "+966500000001", "msg": {"chatId": HUB, "title": "Students Hub", "kind": "supergroup", "senderId": 200 + i, "senderUsername": f"student_{i}", "senderName": f"Student {i}", "text": text}})
        page.wait_for_selector(".mc", timeout=25000); page.wait_for_function("document.querySelectorAll('.mc').length >= 3", timeout=25000); page.wait_for_timeout(600)
        page.screenshot(path="/tmp/shots/09-feed-ar.png", full_page=False)
        page.get_by_role("button", name="70%").click(); page.wait_for_timeout(700); print("cards with 70% bucket filter:", page.locator(".mc").count())
        page.get_by_role("button", name="الكل").first.click(); page.wait_for_timeout(500)
        page.get_by_title("تثبيت").first.click(); page.wait_for_timeout(700); print("pinned chip present:", page.locator(".mc .chip").count() > 0)
        page.get_by_role("button", name="إيقاف البث").click(); ctl("/deliver", {"phone": "+966500000001", "msg": {"chatId": HUB, "title": "Students Hub", "kind": "supergroup", "senderId": 299, "senderUsername": "late", "senderName": "Late", "text": "احتاج مساعدة في مشروع التخرج بعد الإيقاف"}})
        page.wait_for_selector("text=جديد", timeout=20000); print("paused feed buffers new cards: OK"); page.get_by_role("button", name=re.compile("استئناف")).click(); page.wait_for_timeout(500)
        print("feed OK; errors:", len(errors)); [print("  ", e) for e in errors]; errors.clear()

        # every route (AR, desktop)
        routes = ["/", "/feed", "/accounts", "/sources", "/radar", "/keywords", "/rules", "/automations", "/ai", "/search?q=التخرج", "/saved", "/analytics", "/reports", "/alerts", "/blocks", "/tasks", "/system", "/logs", "/settings", "/settings?tab=users", "/settings?tab=profile", "/settings?tab=appearance", "/settings?tab=notifications", "/setup"]
        for r in routes:
            page.goto(BASE + "/#" + r); page.wait_for_selector(".page", timeout=10000); page.wait_for_timeout(900)
            txt = page.locator(".page").inner_text()
            if "حدث خطأ" in txt or "Something went wrong" in txt or "Cannot" in txt: print("PAGE ERROR TEXT on", r, txt[:200])
            name = r.strip("/").replace("/", "_").replace("?", "_").replace("=", "_") or "home"
            page.screenshot(path=f"/tmp/shots/r-{name}.png")
        print("routes done; errors:", len(errors)); [print("  ", e) for e in errors]; errors.clear()

        # English LTR + light theme + mobile
        page.goto(BASE + "/#/"); page.get_by_title("العربية / English").click(); page.wait_for_timeout(800)
        print("dir after toggle:", page.evaluate("document.documentElement.dir"), page.evaluate("document.documentElement.lang"))
        page.screenshot(path="/tmp/shots/10-dashboard-en.png"); page.goto(BASE + "/#/feed"); page.wait_for_selector(".mc"); page.wait_for_timeout(500); page.screenshot(path="/tmp/shots/11-feed-en.png")
        page.get_by_title("السمة" if False else "Theme").click(); page.wait_for_timeout(500); page.screenshot(path="/tmp/shots/12-feed-en-light.png")
        m = b.new_context(viewport={"width": 390, "height": 800}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="ar-SA", storage_state=ctx.storage_state()); mp = m.new_page(); hook(mp, "mobile")
        mp.goto(BASE + "/#/feed"); mp.wait_for_selector(".mc", timeout=15000); mp.wait_for_timeout(600); mp.screenshot(path="/tmp/shots/13-feed-mobile.png")
        mp.goto(BASE + "/#/"); mp.wait_for_selector(".kpi"); mp.wait_for_timeout(600); mp.screenshot(path="/tmp/shots/14-dashboard-mobile.png")
        mp.get_by_label("Menu").click(); mp.wait_for_timeout(400); mp.screenshot(path="/tmp/shots/15-menu-mobile.png")
        overflow = mp.evaluate("document.documentElement.scrollWidth > window.innerWidth + 2"); print("mobile horizontal overflow:", overflow)
        print("final errors:", len(errors)); [print("  ", e) for e in errors]
        b.close()


with sync_playwright() as p:
    try:
        run(p)
    except Exception as exc:
        print('FAILED:', exc)
        try:
            pg = PAGE['p']; pg.screenshot(path='/tmp/shots/fail.png'); print('--- page text ---'); print(pg.locator('body').inner_text()[:900])
        except Exception as e: print('dump failed', e)
        for e in errors: print('  ', e)
