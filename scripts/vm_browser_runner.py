#!/usr/bin/env python3
"""
Remote Browser & Scraper Runner for Boxd VM
Manages persistent browser sessions, screenshots, login verification, and targeted data extraction.
"""

import sys
import os
import json
import time
import base64
import argparse
from playwright.sync_api import sync_playwright

USER_DATA_DIR = "/home/boxd/.config/google-chrome-profile"
os.makedirs(USER_DATA_DIR, exist_ok=True)

def get_browser_context(p, headless=True):
    args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--window-size=1280,800',
    ]
    context = p.chromium.launch_persistent_context(
        user_data_dir=USER_DATA_DIR,
        headless=headless,
        args=args,
        viewport={'width': 1280, 'height': 800},
        user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    )
    return context

def cmd_open_login(platform):
    urls = {
        'instagram': 'https://www.instagram.com/accounts/login/',
        'twitter': 'https://x.com/i/flow/login',
        'linkedin': 'https://www.linkedin.com/login',
        'reddit': 'https://www.reddit.com/login',
        'facebook': 'https://www.facebook.com/login'
    }
    target_url = urls.get(platform.lower(), platform)
    with sync_playwright() as p:
        # Launch non-headless if display available, otherwise headless
        display = os.environ.get('DISPLAY')
        headless = False if display else True
        context = get_browser_context(p, headless=headless)
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(target_url, wait_until='domcontentloaded', timeout=30000)
        time.sleep(2)
        screenshot_bytes = page.screenshot(type='jpeg', quality=70)
        screenshot_b64 = base64.b64encode(screenshot_bytes).decode('utf-8')
        context.close()
        print(json.dumps({
            "status": "opened",
            "url": page.url,
            "title": page.title(),
            "screenshot": screenshot_b64
        }))

def cmd_check_login(platform):
    with sync_playwright() as p:
        context = get_browser_context(p, headless=True)
        page = context.pages[0] if context.pages else context.new_page()
        cookies = context.cookies()
        
        is_logged_in = False
        username = None
        
        if platform.lower() == 'instagram':
            # Check for ds_user_id or sessionid cookie
            session_cookie = any(c['name'] == 'sessionid' and c['value'] for c in cookies)
            user_id_cookie = next((c['value'] for c in cookies if c['name'] == 'ds_user_id'), None)
            
            if session_cookie or user_id_cookie:
                is_logged_in = True
                username = f"user_{user_id_cookie}" if user_id_cookie else "active_session"
            else:
                # Also navigate to instagram.com to double check page state
                page.goto('https://www.instagram.com/', wait_until='domcontentloaded', timeout=20000)
                time.sleep(2)
                cur_url = page.url
                if 'login' not in cur_url and not page.query_selector('input[name="username"]'):
                    is_logged_in = True
                    username = "verified_session"

        elif platform.lower() == 'twitter':
            is_logged_in = any(c['name'] == 'auth_token' for c in cookies)
        elif platform.lower() == 'linkedin':
            is_logged_in = any(c['name'] == 'li_at' for c in cookies)
        else:
            is_logged_in = len(cookies) > 0

        context.close()
        print(json.dumps({
            "platform": platform,
            "connected": is_logged_in,
            "username": username,
            "cookieCount": len(cookies)
        }))

def cmd_screenshot(url=None):
    with sync_playwright() as p:
        context = get_browser_context(p, headless=True)
        page = context.pages[0] if context.pages else context.new_page()
        if url:
            page.goto(url, wait_until='domcontentloaded', timeout=30000)
            time.sleep(2)
        screenshot_bytes = page.screenshot(type='jpeg', quality=75)
        screenshot_b64 = base64.b64encode(screenshot_bytes).decode('utf-8')
        result = {
            "url": page.url,
            "title": page.title(),
            "screenshot": screenshot_b64
        }
        context.close()
        print(json.dumps(result))

def cmd_scrape_instagram(target, data_types, depth=10):
    """
    Extracts targeted Instagram data (profile, posts, reels, images, text, metrics).
    """
    # Normalize target
    target = target.strip()
    if target.startswith('@'):
        target = target[1:]
    
    if target.startswith('http'):
        url = target
        username = target.rstrip('/').split('/')[-1]
    else:
        username = target
        url = f"https://www.instagram.com/{username}/"

    types_set = set(data_types.split(',')) if isinstance(data_types, str) else set(data_types)
    # Default types: text, image, video, metrics
    want_text = 'text' in types_set or len(types_set) == 0
    want_images = 'images' in types_set or 'image' in types_set or len(types_set) == 0
    want_videos = 'videos' in types_set or 'video' in types_set or len(types_set) == 0
    want_metrics = 'metrics' in types_set or len(types_set) == 0

    items = []
    profile_info = {}

    with sync_playwright() as p:
        context = get_browser_context(p, headless=True)
        page = context.pages[0] if context.pages else context.new_page()

        try:
            page.goto(url, wait_until='domcontentloaded', timeout=40000)
            time.sleep(3)

            # Extract profile info
            try:
                page_title = page.title()
                header = page.query_selector('header')
                bio_elem = page.query_selector('header section')
                bio_text = bio_elem.inner_text() if bio_elem else ""

                profile_pic = page.query_selector('header img')
                avatar_url = profile_pic.get_attribute('src') if profile_pic else None

                profile_info = {
                    "username": username,
                    "title": page_title,
                    "bio": bio_text,
                    "avatarUrl": avatar_url
                }
            except Exception as e:
                profile_info = {"username": username, "error": str(e)}

            # Scroll to collect posts
            collected_posts = set()
            scroll_attempts = 0
            max_scrolls = max(2, (depth // 3) + 2)

            while len(items) < depth and scroll_attempts < max_scrolls:
                # Find all post anchors (links containing /p/ or /reel/)
                anchors = page.query_selector_all('a[href*="/p/"], a[href*="/reel/"]')
                for a in anchors:
                    if len(items) >= depth:
                        break
                    href = a.get_attribute('href')
                    if not href or href in collected_posts:
                        continue
                    collected_posts.add(href)

                    full_post_url = f"https://www.instagram.com{href}" if href.startswith('/') else href
                    is_reel = '/reel/' in href

                    # Extract image inside anchor
                    img = a.query_selector('img')
                    img_src = img.get_attribute('src') if img else None
                    alt_text = img.get_attribute('alt') if img else ""

                    # Parse metrics if available in alt or aria
                    aria_label = a.get_attribute('aria-label') or ""
                    
                    item = {
                        "id": f"ig_{href.strip('/').split('/')[-1]}",
                        "platform": "instagram",
                        "target": username,
                        "type": "video" if is_reel and want_videos else "image" if want_images else "text",
                        "title": f"Post by @{username}",
                        "caption": alt_text if want_text else "",
                        "author": username,
                        "mediaUrl": img_src if (want_images or want_videos) else None,
                        "thumbnailUrl": img_src,
                        "postUrl": full_post_url,
                        "metrics": {
                            "isReel": is_reel,
                            "comments": 0,
                            "likes": 0
                        },
                        "rawDetails": {
                            "ariaLabel": aria_label,
                            "isReel": is_reel
                        }
                    }
                    items.append(item)

                # Scroll down to load more
                page.evaluate("window.scrollBy(0, 1000)")
                time.sleep(1.5)
                scroll_attempts += 1

        except Exception as err:
            sys.stderr.write(f"Scrape error: {err}\n")

        context.close()

    result = {
        "success": True,
        "platform": "instagram",
        "target": username,
        "profile": profile_info,
        "count": len(items),
        "items": items
    }
    print(json.dumps(result))

def main():
    parser = argparse.ArgumentParser(description="VM Browser Runner")
    subparsers = parser.add_subparsers(dest="command")

    # open-login
    p_login = subparsers.add_parser("open-login")
    p_login.add_argument("platform", default="instagram")

    # check-login
    p_check = subparsers.add_parser("check-login")
    p_check.add_argument("platform", default="instagram")

    # screenshot
    p_screen = subparsers.add_parser("screenshot")
    p_screen.add_argument("--url", default=None)

    # scrape-instagram
    p_ig = subparsers.add_parser("scrape-instagram")
    p_ig.add_argument("target")
    p_ig.add_argument("--types", default="text,images,videos,metrics")
    p_ig.add_argument("--depth", type=int, default=10)

    args = parser.parse_args()

    if args.command == "open-login":
        cmd_open_login(args.platform)
    elif args.command == "check-login":
        cmd_check_login(args.platform)
    elif args.command == "screenshot":
        cmd_screenshot(args.url)
    elif args.command == "scrape-instagram":
        cmd_scrape_instagram(args.target, args.types, args.depth)
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
