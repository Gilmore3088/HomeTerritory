"""Golden-path E2E for Territory against the local stack. See README.md.

Deterministic and self-reverting: reads correct answers from the local
DB, flips the season status only for the season-complete check and
restores it in a finally block. Requires the seeded demo league.
"""
import os
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

BASE = os.environ.get("E2E_BASE_URL", "http://localhost:3000")
PASSWORD = "playtest-password-1"
COMMISH = "commish@playtest.local"
MEMBER = "member@playtest.local"
DB_CONTAINER = "supabase_db_HomeTerritory"
SHOT_DIR = os.path.join(os.path.dirname(__file__), "shots")
MIN_TARGET = 44

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    line = f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else "")
    print(line)
    if not ok:
        failures.append(name)


def db(query: str) -> str:
    out = subprocess.run(
        ["docker", "exec", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", query],
        capture_output=True, text=True,
    )
    return out.stdout.strip()


MEASURE_JS = """
() => {
  const sels = 'button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';
  const items = [];
  for (const el of document.querySelectorAll(sels)) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (r.width === 0 || r.height === 0) continue;
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    items.push({label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30),
                w: Math.round(r.width), h: Math.round(r.height)});
  }
  return {items, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth};
}
"""


def login(page, email: str) -> None:
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    if page.locator('input[type="email"]').count() == 0:
        return
    page.fill('input[type="email"]', email)
    page.fill('input[type="password"]', PASSWORD)
    page.get_by_role("button", name="Enter the map").click()
    page.wait_for_load_state("networkidle")


def wait_toast(page, seconds: int = 8):
    t0 = time.time()
    while time.time() - t0 < seconds:
        el = page.locator("[class*=toast]")
        if el.count():
            text = el.first.inner_text().strip()
            if text:
                return text
        time.sleep(0.2)
    return None


def wait_for(page, selector: str, seconds: int) -> bool:
    t0 = time.time()
    while time.time() - t0 < seconds:
        if page.locator(selector).count():
            return True
        time.sleep(0.5)
    return False


def fresh_page(browser, width: int = 390):
    ctx = browser.new_context(viewport={"width": width, "height": 844})
    page = ctx.new_page()
    return ctx, page


def section_auth_errors(browser) -> None:
    ctx, page = fresh_page(browser)
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    page.fill('input[type="email"]', COMMISH)
    page.fill('input[type="password"]', "wrong-password")
    page.get_by_role("button", name="Enter the map").click()
    check("wrong-password error is visible", wait_toast(page) is not None)
    ctx.close()

    ctx, page = fresh_page(browser)
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    page.get_by_role("button", name="Join playtest").click()
    page.wait_for_timeout(400)
    invite = db("select invite_code from groups where name ilike '%Advance Demo%' limit 1")
    page.fill('input[placeholder="9BCDF13C"]', invite)
    page.fill('input[type="email"]', COMMISH)
    page.fill('input[type="password"]', PASSWORD)
    page.locator('input:not([type=email]):not([type=password]):not([placeholder="9BCDF13C"])').first.fill("Dup")
    page.get_by_role("button", name="Create account and join").click()
    toast = wait_toast(page)
    check("duplicate-email error is visible", toast is not None, repr(toast))
    ctx.close()


def section_shell_and_question(browser) -> None:
    ctx, page = fresh_page(browser)
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("dialog", lambda d: (failures.append("native dialog appeared"), d.dismiss()))
    login(page, COMMISH)
    check("map shell renders", wait_for(page, "[class*=missionDock]", 15))
    check("bottom nav renders", page.get_by_role("button", name="Standings").count() > 0)

    uid = db(f"select id from auth.users where email='{COMMISH}'")
    dock_cta = page.locator("[class*=missionDock] button")
    clickable = dock_cta.count() and page.evaluate(
        "getComputedStyle(document.querySelector('[class*=missionDock] button')).pointerEvents"
    ) != "none"
    if clickable:
        dock_cta.first.click()
        if wait_for(page, "[class*=questionCard]", 10):
            check("question timer renders", page.locator("[class*=timer]").count() > 0)
            check("in-app report button present", page.locator("[class*=__report]").count() > 0)
            check("chrome hidden in arena", page.locator("[class*=__logout]").count() == 0)
            answer = db(
                "select q.correct_answer from question_attempts qa "
                "join questions q on q.id = qa.question_id "
                f"where qa.user_id = '{uid}' and qa.answered_at is null "
                "order by qa.served_at desc limit 1"
            )
            buttons = page.locator("[class*=answerGrid] button")
            for i in range(buttons.count()):
                if buttons.nth(i).inner_text().strip().lower() == answer.strip().lower():
                    buttons.nth(i).click()
                    break
            lock = page.locator("[class*=lockButton]")
            if lock.count():
                lock.first.click()
            check("result poster renders", wait_for(page, "[class*=resultPage]", 10))
            check("chrome hidden on poster", page.locator("[class*=__logout]").count() == 0)
            cont = page.locator("[class*=resultPage] button")
            if cont.count():
                cont.first.click()
            check("returns to map", wait_for(page, "[class*=missionDock]", 10))
        else:
            print("SKIP  question flow (no session opened)")
    else:
        print("SKIP  question flow (no playable dock CTA for commish right now)")
    check("no console errors in shell/question flow", not errors, "; ".join(errors[:3]))
    ctx.close()


def section_load_error(browser) -> None:
    ctx, page = fresh_page(browser)
    login(page, COMMISH)
    wait_for(page, "[class*=missionDock]", 15)
    page.route("**/rest/v1/rpc/group_snapshot*", lambda r: r.abort())
    page.reload()
    check("LoadErrorScreen after repeated failures", wait_for(page, "[class*=loadErrorCard]", 55))
    page.unroute("**/rest/v1/rpc/group_snapshot*")
    retry = page.get_by_role("button", name="Retry")
    if retry.count():
        retry.first.click()
        check("Retry recovers to the map", wait_for(page, "[class*=missionDock]", 15))
    else:
        check("Retry button present", False)
    ctx.close()

    ctx, page = fresh_page(browser)
    login(page, COMMISH)
    wait_for(page, "[class*=missionDock]", 15)
    page.route("**/rest/v1/rpc/get_my_groups*", lambda r: r.abort())
    page.reload()
    wait_for(page, "[class*=loadErrorCard]", 55)
    check("groups failure never leaks LeagueEntry", page.locator("text=/invite code/i").count() == 0)
    ctx.close()


def section_account_switch(browser) -> None:
    ctx, page = fresh_page(browser)
    login(page, COMMISH)
    wait_for(page, "[class*=missionDock]", 15)
    page.get_by_role("button", name="Log out").click()
    check("sign-out returns to auth", wait_for(page, 'input[type="email"]', 10))
    keys = page.evaluate("Object.keys(localStorage).filter(k=>k.includes('territory'))")
    check("scoped storage cleared on sign-out", keys == [])
    page.fill('input[type="email"]', MEMBER)
    page.fill('input[type="password"]', PASSWORD)
    page.get_by_role("button", name="Enter the map").click()
    leaked = False
    t0 = time.time()
    while time.time() - t0 < 6:
        frame = page.evaluate(
            "() => ({chip: document.querySelector('[class*=profilePill]')?.textContent || '',"
            " q: !!document.querySelector('[class*=questionPage]'),"
            " r: !!document.querySelector('[class*=resultPage]')})"
        )
        if "Commish" in frame["chip"] or frame["q"] or frame["r"]:
            leaked = True
            break
        time.sleep(0.08)
    check("no frame leaks previous user's state", not leaked)
    banner = page.evaluate("document.querySelector('aside[class*=turn]')?.innerText || ''")
    if "Your turn" not in banner:
        check("off-turn banner names turn holder", "turn" in banner.lower() and "ACTIONS SPENT" not in banner)
    ctx.close()


def section_season_complete(browser) -> None:
    season = db("select s.id from seasons s join groups g on g.id=s.group_id where g.name ilike '%Advance Demo%'")
    db(f"update seasons set status='ended' where id='{season}'")
    try:
        ctx, page = fresh_page(browser)
        login(page, COMMISH)
        found = wait_for(page, "text=Season complete", 20)
        check("season-complete panel renders", found)
        check("frozen shell not shown", page.locator("[class*=missionDock]").count() == 0)
        ctx.close()
    finally:
        db(f"update seasons set status='active' where id='{season}'")


def section_touch_targets(browser) -> None:
    for width in (390, 360):
        ctx, page = fresh_page(browser, width)
        login(page, COMMISH)
        wait_for(page, "[class*=missionDock]", 15)
        data = page.evaluate(MEASURE_JS)
        small = [i for i in data["items"] if i["w"] < MIN_TARGET or i["h"] < MIN_TARGET]
        check(f"all targets >=44px @{width}", not small, "; ".join(f"{s['label']} {s['w']}x{s['h']}" for s in small[:4]))
        check(f"no horizontal overflow @{width}", data["overflow"] <= 0, f"{data['overflow']}px")
        ctx.close()


def main() -> int:
    os.makedirs(SHOT_DIR, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        section_auth_errors(browser)
        section_shell_and_question(browser)
        section_load_error(browser)
        section_account_switch(browser)
        section_season_complete(browser)
        section_touch_targets(browser)
        browser.close()
    print(f"\n{'ALL GREEN' if not failures else f'{len(failures)} FAILURE(S)'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
