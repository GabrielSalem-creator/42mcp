#!/usr/bin/env python3
"""
Boxd Unified VM Agent & Scraper Controller
Connects directly to the live X11/Xpra display (:100) and agent-browser daemon.
Ensures 100% synchronization between Boxd Live Desktop, AI agent, and Web UI.
Includes smart URL normalization to prevent DNS_PROBE_FINISHED_NXDOMAIN errors.
"""

import sys
import os
import json
import time
import base64
import subprocess
import argparse

DISPLAY_ENV = os.environ.copy()
DISPLAY_ENV["DISPLAY"] = ":100"

COMMON_TLDS = (".com", ".org", ".net", ".io", ".co", ".sh", ".ai", ".app", ".dev", ".xyz", ".me", ".edu", ".gov")

def normalize_url(raw_input, default_platform="web"):
    """
    Normalizes any input (bare username, handle with @, domain without https, or full URL)
    into a valid, resolvable web URL. Prevents Chrome DNS_PROBE_FINISHED_NXDOMAIN errors.
    """
    if not raw_input:
        return "https://www.google.com"

    raw = raw_input.strip()

    # Already has protocol
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw

    # Explicit handle with @
    if raw.startswith("@"):
        username = raw[1:]
        if default_platform.lower() == "twitter":
            return f"https://x.com/{username}"
        elif default_platform.lower() == "linkedin":
            return f"https://www.linkedin.com/in/{username}"
        else:
            return f"https://www.instagram.com/{username}/"

    # Known domain in string
    if "instagram.com" in raw:
        return f"https://{raw.lstrip('/')}"
    if "x.com" in raw or "twitter.com" in raw:
        return f"https://{raw.lstrip('/')}"
    if "linkedin.com" in raw:
        return f"https://{raw.lstrip('/')}"

    # Contains dot and valid domain
    first_segment = raw.split("/")[0].lower()
    if any(first_segment.endswith(tld) for tld in COMMON_TLDS) or ("." in first_segment and " " not in first_segment):
        return f"https://{raw}"

    # Platform-specific handle handling if specified
    if default_platform.lower() == "instagram":
        return f"https://www.instagram.com/{raw}/"
    elif default_platform.lower() == "twitter":
        return f"https://x.com/{raw}"
    elif default_platform.lower() == "linkedin":
        return f"https://www.linkedin.com/in/{raw}"
    else:
        # Bare name like 'natgeo' in general browser navigation -> www.<raw>.com
        return f"https://www.{raw}.com"

def run_agent_cmd(cmd_list, timeout=45):
    """Executes an agent-browser command on DISPLAY=:100 and returns stdout."""
    full_cmd = ["agent-browser"] + cmd_list
    try:
        proc = subprocess.run(
            full_cmd,
            env=DISPLAY_ENV,
            capture_output=True,
            text=True,
            timeout=timeout
        )
        return proc.stdout.strip(), proc.stderr.strip(), proc.returncode
    except subprocess.TimeoutExpired:
        return "", "Command timed out", -1
    except Exception as e:
        return "", str(e), -1

def run_agent_eval_js(js_code, timeout=45):
    """Run multiline JS in the live browser via agent-browser eval (requires shell)."""
    with open("/tmp/extract_fn.js", "w", encoding="utf-8") as f:
        f.write(js_code)
    try:
        proc = subprocess.run(
            'agent-browser eval "$(cat /tmp/extract_fn.js)"',
            env=DISPLAY_ENV,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout
        )
        return proc.stdout.strip(), proc.stderr.strip(), proc.returncode
    except subprocess.TimeoutExpired:
        return "", "Eval timed out", -1
    except Exception as e:
        return "", str(e), -1

def parse_eval_json(meta_out):
    meta = {}
    try:
        raw_meta = (meta_out or "").strip()
        if not raw_meta:
            return meta
        if raw_meta.startswith('"') and raw_meta.endswith('"'):
            raw_meta = json.loads(raw_meta)
        meta = json.loads(raw_meta) if isinstance(raw_meta, str) else (raw_meta or {})
    except Exception:
        pass
    return meta

def open_login(platform):
    urls = {
        "instagram": "https://www.instagram.com/",
        "twitter": "https://x.com/i/flow/login",
        "linkedin": "https://www.linkedin.com/login",
        "reddit": "https://www.reddit.com/login"
    }
    url = urls.get(platform.lower(), normalize_url(platform))
    stdout, stderr, code = run_agent_cmd(["open", url])
    time.sleep(2)
    
    snap_res = get_screenshot()
    
    result = {
        "status": "opened" if code == 0 else "opened_with_notice",
        "url": url,
        "stdout": stdout,
        "screenshot": snap_res.get("screenshot", "")
    }
    print(json.dumps(result))

def check_login(platform):
    stdout, stderr, code = run_agent_cmd(["cookies", "--json"])
    cookies = []
    try:
        data = json.loads(stdout)
        cookies = data.get("data", {}).get("cookies", [])
    except Exception:
        pass

    is_logged_in = False
    username = None
    cookie_names = [c.get("name") for c in cookies]

    if platform.lower() == "instagram":
        has_session = any(c.get("name") == "sessionid" and c.get("value") for c in cookies)
        ds_user = next((c.get("value") for c in cookies if c.get("name") == "ds_user_id"), None)
        if has_session or ds_user:
            is_logged_in = True
            username = f"user_{ds_user}" if ds_user else "active_session"
        else:
            url_out, _, _ = run_agent_cmd(["get", "url"])
            if "instagram.com" in url_out and "login" not in url_out and url_out != "https://www.instagram.com/" and len(cookies) > 5:
                snap_out, _, _ = run_agent_cmd(["snapshot", "-i"])
                if "Direct" in snap_out or "Messages" in snap_out or "Home" in snap_out:
                    is_logged_in = True
                    username = "active_session"

    elif platform.lower() == "twitter":
        is_logged_in = any(c.get("name") == "auth_token" for c in cookies)
        username = "twitter_user" if is_logged_in else None
    elif platform.lower() == "linkedin":
        is_logged_in = any(c.get("name") == "li_at" for c in cookies)
        username = "linkedin_user" if is_logged_in else None
    else:
        is_logged_in = len(cookies) > 0

    print(json.dumps({
        "platform": platform,
        "connected": is_logged_in,
        "username": username,
        "cookieCount": len(cookies),
        "cookieNames": cookie_names[:10]
    }))

def get_screenshot(target_url=None, platform="web"):
    if target_url:
        normalized = normalize_url(target_url, default_platform=platform)
        run_agent_cmd(["open", normalized])
        time.sleep(2)

    tmp_path = "/tmp/agent_screen.png"
    run_agent_cmd(["screenshot", tmp_path])
    
    url_out, _, _ = run_agent_cmd(["get", "url"])
    title_out, _, _ = run_agent_cmd(["get", "title"])

    # Detect if Instagram or site gave 429 or chrome-error
    is_error = "chrome-error://" in url_out or "429" in title_out or "isn’t working" in title_out or "isnt working" in title_out
    notice = None
    if is_error:
        if "instagram" in (target_url or "").lower() or (target_url and "@" in target_url):
            notice = "Instagram requires an active authenticated session to access this profile. Please log in via the Visual Login tab."
        else:
            notice = f"The requested page returned an error or rate-limit ({title_out})."

    b64 = ""
    if os.path.exists(tmp_path):
        try:
            with open(tmp_path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")
        except Exception:
            pass

    return {
        "url": url_out,
        "title": title_out,
        "screenshot": b64,
        "errorNotice": notice
    }

def scrape_instagram(target, data_types, depth=10):
    url = normalize_url(target, default_platform="instagram")
    clean_name = target.strip().lstrip("@").rstrip("/").split("/")[-1]
    username = clean_name if clean_name and "instagram.com" not in clean_name else "user"

    types_set = set(data_types.split(",")) if isinstance(data_types, str) else set(data_types)
    want_text = "text" in types_set or len(types_set) == 0
    want_images = "images" in types_set or "image" in types_set or len(types_set) == 0
    want_videos = "videos" in types_set or "video" in types_set or len(types_set) == 0
    want_metrics = "metrics" in types_set or len(types_set) == 0

    # Open verified URL
    run_agent_cmd(["open", url])
    time.sleep(3)

    url_cur, _, _ = run_agent_cmd(["get", "url"])
    title_cur, _, _ = run_agent_cmd(["get", "title"])

    items = []
    collected_hrefs = set()
    scroll_count = 0
    max_scrolls = max(2, (depth // 3) + 2)

    # JS extraction script for full profile, stories/highlights, and posts
    js_extract = """
    (() => {
        const title = document.title;
        const header = document.querySelector('header');
        const headerText = header ? header.innerText : '';
        const avatar = document.querySelector('header img')?.src || '';

        // Follower / Following stats
        const statsElements = Array.from(document.querySelectorAll('header section ul li, header ul li'));
        const stats = statsElements.map(li => li.innerText.replace('\\n', ' '));

        // Stories / Highlights
        const hasActiveStory = Boolean(document.querySelector('header canvas, header [aria-label*="story"], header [role="button"][tabindex="0"] canvas'));
        const highlightElements = Array.from(document.querySelectorAll('header ~ div ul li, div[role="menu"] li, main ul li'));
        const highlights = highlightElements.map(li => {
            const t = li.querySelector('div[role="button"], span, div')?.innerText || li.innerText || '';
            const img = li.querySelector('img')?.src || '';
            return { title: t.trim(), cover: img };
        }).filter(h => h.title && h.title.length < 40).slice(0, 10);

        // Posts
        const anchors = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'));
        const posts = anchors.map(a => {
            const href = a.getAttribute('href');
            const img = a.querySelector('img');
            const imgSrc = img ? img.getAttribute('src') : null;
            const alt = img ? img.getAttribute('alt') : '';
            const isReel = href ? href.includes('/reel/') : false;
            return { href, imgSrc, alt, isReel };
        });

        return {
            title,
            headerText,
            avatar,
            stats,
            hasActiveStory,
            highlights,
            posts
        };
    })()
    """
    
    meta = {}

    while len(items) < depth and scroll_count < max_scrolls:
        meta_out, _, _ = run_agent_eval_js(js_extract)
        meta = parse_eval_json(meta_out) or meta

        for el in meta.get("posts", []):
            href = el.get("href")
            if not href or href in collected_hrefs:
                continue
            collected_hrefs.add(href)

            is_reel = el.get("isReel", False)
            full_post_url = f"https://www.instagram.com{href}" if href.startswith("/") else href
            post_id = href.strip("/").split("/")[-1]

            items.append({
                "id": f"ig_{post_id}",
                "platform": "instagram",
                "target": username,
                "type": "video" if is_reel and want_videos else "image" if want_images else "text",
                "title": f"Post by @{username}",
                "caption": el.get("alt", "") if want_text else "",
                "author": username,
                "mediaUrl": el.get("imgSrc") if (want_images or want_videos) else None,
                "thumbnailUrl": el.get("imgSrc"),
                "postUrl": full_post_url,
                "metrics": {
                    "isReel": is_reel,
                    "likes": 0,
                    "comments": 0
                }
            })
            if len(items) >= depth:
                break

        if len(items) >= depth:
            break

        run_agent_cmd(["mouse", "wheel", "1000"])
        time.sleep(1.5)
        scroll_count += 1

    # Take screenshot of the loaded page
    snap_data = get_screenshot()

    profile_info = {
        "username": username,
        "title": meta.get("title", title_cur),
        "url": url_cur,
        "avatar": meta.get("avatar", ""),
        "bio": meta.get("headerText", ""),
        "stats": meta.get("stats", []),
        "hasActiveStory": meta.get("hasActiveStory", False),
        "highlights": meta.get("highlights", [])
    }

    result = {
        "success": True,
        "platform": "instagram",
        "target": username,
        "profile": profile_info,
        "count": len(items),
        "items": items,
        "screenshot": snap_data.get("screenshot", ""),
        "requiresLogin": len(items) == 0 and ("login" in url_cur or "Login" in title_cur)
    }
    print(json.dumps(result))

def search_instagram_profiles(query, limit=25, name_contains=None):
    """Discover IG usernames via logged-in search API + keyword explore page."""
    import urllib.parse

    q = (query or "").strip().lstrip("@")
    limit = max(5, min(int(limit or 25), 40))
    nc = (name_contains or q or "").strip().lower()
    profiles = []
    seen = set()

    def ingest_users(rows):
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            u = (row.get("username") or (row.get("user") or {}).get("username") or "").strip().lower()
            name = (row.get("full_name") or row.get("name") or (row.get("user") or {}).get("full_name") or "")
            if not u or u in seen:
                continue
            if nc and nc not in u and nc not in name.lower():
                continue
            seen.add(u)
            profiles.append({"username": u, "full_name": name})

    query_variants = list(dict.fromkeys([q, f"{q} university", f"{q}u", f"{q} official"]))

    run_agent_cmd(["open", "https://www.instagram.com/"])
    time.sleep(2)

    for variant in query_variants:
        if len(profiles) >= limit:
            break
        js_api = f"""
        (async () => {{
            const q = {json.dumps(variant)};
            const hdr = {{ 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest' }};
            const urls = [
              'https://www.instagram.com/web/search/topsearch/?query=' + encodeURIComponent(q),
              'https://www.instagram.com/api/v1/web/search/topsearch/?query=' + encodeURIComponent(q)
            ];
            for (const url of urls) {{
              try {{
                const r = await fetch(url, {{ credentials: 'include', headers: hdr }});
                if (!r.ok) continue;
                const j = await r.json();
                const users = (j.users || []).map(x => ({{
                  username: x.user.username,
                  full_name: x.user.full_name || ''
                }}));
                return {{ ok: true, users }};
              }} catch (e) {{}}
            }}
            return {{ ok: false, users: [] }};
        }})()
        """
        meta_out, _, _ = run_agent_eval_js(js_api, timeout=60)
        meta = parse_eval_json(meta_out)
        if isinstance(meta, dict) and meta.get("users"):
            ingest_users(meta["users"])

    if len(profiles) < limit:
        search_url = f"https://www.instagram.com/explore/search/keyword/?q={urllib.parse.quote(q)}"
        run_agent_cmd(["open", search_url])
        time.sleep(3)
        js_accounts_tab = """
        (() => {
            const nodes = Array.from(document.querySelectorAll('a, button, span, div[role="tab"]'));
            const hit = nodes.find(el => /^accounts$/i.test((el.innerText || '').trim()));
            if (hit) { hit.click(); return 'accounts'; }
            return 'no_tab';
        })()
        """
        run_agent_eval_js(js_accounts_tab)
        time.sleep(1.5)
        js_dom = """
        (() => {
            const skip = new Set(['explore','reels','direct','accounts','p','reel','stories','about','legal','privacy','help','directory']);
            const out = [];
            const seen = new Set();
            for (const a of document.querySelectorAll('a[href^="/"]')) {
                const h = a.getAttribute('href');
                const m = h && h.match(/^\\/([A-Za-z0-9._]+)\\/?$/);
                if (!m) continue;
                const u = m[1].toLowerCase();
                if (skip.has(u) || seen.has(u)) continue;
                seen.add(u);
                const label = (a.innerText || '').replace(/\\n/g, ' ').trim();
                out.push({ username: u, full_name: label });
            }
            return out;
        })()
        """
        for _ in range(12):
            dom_out, _, _ = run_agent_eval_js(js_dom)
            batch = parse_eval_json(dom_out)
            if isinstance(batch, list):
                ingest_users(batch)
            if len(profiles) >= limit:
                break
            run_agent_cmd(["mouse", "wheel", "900"])
            time.sleep(1.2)

    usernames = [p["username"] for p in profiles[:limit]]
    print(json.dumps({
        "success": True,
        "query": q,
        "name_contains": nc,
        "profiles": usernames,
        "details": profiles[:limit],
        "count": len(usernames)
    }))


def scrape_instagram_stories(target, max_stories=15):
    """Open profile story ring and collect story media URLs from the VM browser."""
    clean = target.strip().lstrip("@").rstrip("/").split("/")[-1]
    if clean.lower() == "mcgill":
        clean = "mcgillu"
    username = clean

    url = normalize_url(username, default_platform="instagram")
    run_agent_cmd(["open", url])
    time.sleep(3)

    js_open_story = """
    (() => {
        const ring = document.querySelector('header canvas')?.closest('[role="button"]');
        if (ring) { ring.click(); return 'opened'; }
        const alt = document.querySelector('header [role="button"] canvas, header div[role="button"]');
        if (alt) { alt.click(); return 'opened_alt'; }
        return 'no_story';
    })()
    """

    js_story_media = """
    (() => {
        const video = document.querySelector('video');
        const imgCandidates = Array.from(document.querySelectorAll('img'))
            .map(i => i.currentSrc || i.src)
            .filter(s => s && (s.includes('cdninstagram') || s.includes('fbcdn')));
        return {
            pageUrl: location.href,
            videoUrl: video ? (video.currentSrc || video.src) : null,
            poster: video ? video.poster : null,
            imageUrl: imgCandidates.length ? imgCandidates[imgCandidates.length - 1] : null
        };
    })()
    """

    open_out, _, _ = run_agent_eval_js(js_open_story)
    opened = "no_story" not in str(open_out).lower()

    story_items = []
    if opened:
        time.sleep(2)
        seen_urls = set()
        for idx in range(max(1, min(max_stories, 25))):
            media_out, _, _ = run_agent_eval_js(js_story_media)
            media = parse_eval_json(media_out) or {}
            media_url = media.get("videoUrl") or media.get("imageUrl") or media.get("poster")
            page_url = media.get("pageUrl") or ""
            if media_url and str(media_url).startswith("blob:"):
                media_url = None
            if media_url and media_url not in seen_urls:
                seen_urls.add(media_url)
                story_items.append({
                    "id": f"ig_story_{username}_{idx}_{len(seen_urls)}",
                    "platform": "instagram",
                    "target": username,
                    "type": "story",
                    "title": f"Story @{username} #{len(story_items) + 1}",
                    "caption": f"Instagram story frame for @{username}",
                    "author": username,
                    "mediaUrl": media_url,
                    "thumbnailUrl": media.get("imageUrl") or media.get("poster") or media_url,
                    "postUrl": page_url,
                    "metrics": {"isStory": True, "frameIndex": len(story_items)}
                })
            run_agent_cmd(["press", "ArrowRight"])
            time.sleep(1.2)
            url_cur, _, _ = run_agent_cmd(["get", "url"])
            if f"/{username}/" in url_cur and "/stories/" not in url_cur:
                break

    # Highlight covers from profile (archived story rings)
    meta_out, _, _ = run_agent_eval_js("""
    (() => {
        const highlightElements = Array.from(document.querySelectorAll('header ~ div ul li, main ul li'));
        return highlightElements.map(li => {
            const t = (li.querySelector('span, div')?.innerText || li.innerText || '').trim();
            const img = li.querySelector('img')?.src || '';
            return { title: t, cover: img };
        }).filter(h => h.cover && h.title && h.title.length < 50).slice(0, 12);
    })()
    """)
    highlights = parse_eval_json(meta_out) or []
    if isinstance(highlights, list):
        for h in highlights:
            cover = h.get("cover")
            if not cover:
                continue
            story_items.append({
                "id": f"ig_highlight_{username}_{h.get('title', '')[:20]}",
                "platform": "instagram",
                "target": username,
                "type": "story_highlight",
                "title": f"Highlight: {h.get('title', '')}",
                "caption": h.get("title", ""),
                "author": username,
                "mediaUrl": cover,
                "thumbnailUrl": cover,
                "metrics": {"isHighlight": True}
            })

    result = {
        "success": True,
        "platform": "instagram",
        "target": username,
        "storyCount": len(story_items),
        "openedLiveStory": opened,
        "items": story_items
    }
    print(json.dumps(result))

def import_cookies(platform, raw_input):
    platform = platform.lower()
    domain = ".instagram.com" if platform == "instagram" else f".{platform}.com"
    base_url = f"https://www.{platform}.com" if platform != "twitter" else "https://x.com"

    cookies_to_set = []

    # Case 1: JSON array or JSON object
    try:
        parsed = json.loads(raw_input)
        if isinstance(parsed, list):
            for item in parsed:
                if isinstance(item, dict) and item.get("name") and item.get("value"):
                    cookies_to_set.append({
                        "name": str(item["name"]).strip(),
                        "value": str(item["value"]).strip(),
                        "domain": item.get("domain", domain),
                        "path": item.get("path", "/")
                    })
        elif isinstance(parsed, dict):
            for k, v in parsed.items():
                cookies_to_set.append({
                    "name": str(k).strip(),
                    "value": str(v).strip(),
                    "domain": domain,
                    "path": "/"
                })
    except Exception:
        # Case 2: Cookie header string: "name1=val1; name2=val2"
        if ";" in raw_input or "=" in raw_input:
            parts = raw_input.split(";")
            for p in parts:
                if "=" in p:
                    k, v = p.split("=", 1)
                    k = k.strip()
                    v = v.strip()
                    if k and v:
                        cookies_to_set.append({
                            "name": k,
                            "value": v,
                            "domain": domain,
                            "path": "/"
                        })
        else:
            # Case 3: Bare sessionid string (e.g. "12345%3Aabc...")
            raw_val = raw_input.strip()
            if raw_val:
                cookies_to_set.append({
                    "name": "sessionid",
                    "value": raw_val,
                    "domain": domain,
                    "path": "/"
                })
                if "%3A" in raw_val:
                    uid = raw_val.split("%3A")[0]
                    cookies_to_set.append({
                        "name": "ds_user_id",
                        "value": uid,
                        "domain": domain,
                        "path": "/"
                    })

    # Set each cookie into agent-browser
    set_count = 0
    for c in cookies_to_set:
        c_dom = c.get("domain", domain)
        stdout, stderr, code = run_agent_cmd(["cookies", "set", c["name"], c["value"], "--domain", c_dom, "--url", base_url, "--secure"])
        if code == 0:
            set_count += 1

    # Open verified URL
    run_agent_cmd(["open", f"{base_url}/"])
    time.sleep(3)

    return check_login(platform)

def set_proxy(proxy_url):
    """
    Configures HTTP/HTTPS/SOCKS5 proxy in /home/boxd/.config/boxd/agent-browser.env
    """
    env_path = "/home/boxd/.config/boxd/agent-browser.env"
    lines = []
    if os.path.exists(env_path):
        with open(env_path, "r") as f:
            for line in f:
                if not any(k in line for k in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "AGENT_BROWSER_PROXY"]):
                    lines.append(line.rstrip("\n"))

    if proxy_url and proxy_url.strip():
        p = proxy_url.strip()
        lines.append(f'export HTTP_PROXY="{p}"')
        lines.append(f'export HTTPS_PROXY="{p}"')
        lines.append(f'export ALL_PROXY="{p}"')
        lines.append(f'export AGENT_BROWSER_PROXY="{p}"')
        msg = f"Proxy configured to {p}"
    else:
        msg = "Proxy cleared"

    with open(env_path, "w") as f:
        f.write("\n".join(lines) + "\n")

    print(json.dumps({"success": True, "message": msg}))

def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command")

    p_login = subparsers.add_parser("open-login")
    p_login.add_argument("platform", default="instagram")

    p_check = subparsers.add_parser("check-login")
    p_check.add_argument("platform", default="instagram")

    p_snap = subparsers.add_parser("screenshot")
    p_snap.add_argument("--url", default=None)
    p_snap.add_argument("--platform", default="web")

    p_scrape = subparsers.add_parser("scrape-instagram")
    p_scrape.add_argument("target")
    p_scrape.add_argument("--types", default="text,images,videos,metrics")
    p_scrape.add_argument("--depth", type=int, default=10)

    p_stories = subparsers.add_parser("scrape-instagram-stories")
    p_stories.add_argument("target")
    p_stories.add_argument("--max", type=int, default=15)

    p_search = subparsers.add_parser("search-instagram")
    p_search.add_argument("query")
    p_search.add_argument("--limit", type=int, default=25)
    p_search.add_argument("--contains", default=None)

    p_import = subparsers.add_parser("import-cookies")
    p_import.add_argument("platform", default="instagram")
    p_import.add_argument("cookies")

    p_proxy = subparsers.add_parser("set-proxy")
    p_proxy.add_argument("proxy_url", nargs="?", default="")

    args = parser.parse_args()

    if args.command == "open-login":
        open_login(args.platform)
    elif args.command == "check-login":
        check_login(args.platform)
    elif args.command == "screenshot":
        res = get_screenshot(args.url, args.platform)
        print(json.dumps(res))
    elif args.command == "scrape-instagram":
        scrape_instagram(args.target, args.types, args.depth)
    elif args.command == "scrape-instagram-stories":
        scrape_instagram_stories(args.target, args.max)
    elif args.command == "search-instagram":
        search_instagram_profiles(args.query, args.limit, args.contains)
    elif args.command == "import-cookies":
        import_cookies(args.platform, args.cookies)
    elif args.command == "set-proxy":
        set_proxy(args.proxy_url)
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
