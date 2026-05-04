from flask import Flask, render_template, jsonify, send_from_directory
import requests
import json
import os
from datetime import datetime, timedelta
import schedule
import time
import threading
import re

app = Flask(__name__)

# 전역 변수로 주가 데이터 저장
stock_data = None
last_update = None

def fetch_stock_data():
    """네이버에서 DI 주식 데이터를 가져오는 함수"""
    global stock_data, last_update
    
    try:
        # 네이버 신규 차트 API 엔드포인트 사용
        url = "https://api.stock.naver.com/chart/domestic/item/001530?periodType=dayCandle"
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': 'https://m.stock.naver.com/item/home/001530'
        }
        
        response = requests.get(url, headers=headers, timeout=10)
        
        if response.status_code == 200:
            try:
                data = response.json()
            except Exception as e:
                print(f"JSON 파싱 오류: {e}\n본문 스니펫: {response.text[:200]}")
                return False, {
                    'message': 'JSON parse error',
                    'status_code': response.status_code
                }
            stock_data = data
            last_update = datetime.now()
            print(f"주가 데이터 업데이트 완료: {last_update}")
            return True, None
        else:
            print(f"API 요청 실패. 상태 코드: {response.status_code}")
            return False, {
                'message': 'Bad response status',
                'status_code': response.status_code,
                'body': response.text[:200]
            }
            
    except Exception as e:
        print(f"데이터 가져오기 오류: {e}")
        return False, {
            'message': str(e),
            'status_code': None
        }

def scheduled_update():
    """스케줄된 업데이트 함수"""
    print("스케줄된 업데이트 실행 중...")
    fetch_stock_data()

# 스케줄 설정 (매일 오전 9시, 오후 3시에 업데이트)
schedule.every().day.at("09:00").do(scheduled_update)
schedule.every().day.at("15:00").do(scheduled_update)

def run_scheduler():
    """스케줄러 실행 함수"""
    while True:
        schedule.run_pending()
        time.sleep(60)  # 1분마다 체크

@app.route('/')
def index():
    """메인 페이지"""
    # 현재 프로젝트 루트에 있는 index.html을 그대로 서빙
    return send_from_directory(os.path.dirname(__file__), 'index.html')

@app.route('/CI.png')
def serve_ci_image():
    """루트 경로에 있는 CI.png 이미지 서빙 (404 방지)"""
    return send_from_directory(os.path.dirname(__file__), 'CI.png')

@app.route('/favicon.ico')
def serve_favicon():
    """브라우저 기본 파비콘 요청에 대해 204로 응답하여 404 콘솔 경고 방지"""
    return ('', 204)

@app.route('/health')
def health():
    """Render Health Check Endpoint"""
    return jsonify({ 'status': 'ok' })

@app.route('/api/stock-data')
def get_stock_data():
    """주가 데이터 API 엔드포인트"""
    global stock_data, last_update
    
    if stock_data is None:
        # 데이터가 없으면 즉시 가져오기 시도
        success, err = fetch_stock_data()
        if not success:
            # 프론트엔드가 기대하는 스키마를 유지하여 오류 메시지 방지
            return jsonify({
                'data': { 'priceInfos': [] },
                'last_update': None,
                'error': err
            })

    # 응답 스키마 강제 정규화
    normalized = None
    try:
        if isinstance(stock_data, dict) and 'priceInfos' in stock_data:
            normalized = { 'priceInfos': stock_data['priceInfos'] }
        elif isinstance(stock_data, dict) and 'data' in stock_data and isinstance(stock_data['data'], dict) and 'priceInfos' in stock_data['data']:
            normalized = { 'priceInfos': stock_data['data']['priceInfos'] }
        else:
            # 알 수 없는 구조일 때 비어있는 리스트로 방어
            normalized = { 'priceInfos': [] }
    except Exception:
        normalized = { 'priceInfos': [] }

    return jsonify({
        'data': normalized,
        'last_update': last_update.isoformat() if last_update else None
    })

@app.route('/api/update')
def manual_update():
    """수동 업데이트 API 엔드포인트"""
    success, err = fetch_stock_data()
    return jsonify({
        'success': success,
        'last_update': last_update.isoformat() if last_update else None,
        'error': err
    })

def _extract_texts_from_html(html: str) -> list:
    # 매우 단순한 텍스트 추출 (스크립트/스타일 제거 후 태그 제거)
    html = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.IGNORECASE)
    html = re.sub(r"<style[\s\S]*?</style>", " ", html, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", html)
    # 공백 정리
    text = re.sub(r"\s+", " ", text)
    return [text]

def _tokenize_korean(text: str) -> list:
    # 간단 토크나이저: 한글/영문/숫자 조합 토큰 추출
    tokens = re.findall(r"[가-힣A-Za-z0-9]{2,}", text)
    # 후처리: 조사 '의' 제거
    normalized = []
    for t in tokens:
        if t.endswith('의') and len(t) > 2:
            t = t[:-1]
        normalized.append(t)
    return normalized

def _filter_stopwords(tokens: list) -> list:
    stopwords = set([
        '그리고','하지만','그러나','그래서','이번','오늘','내일','이번주','지난달','지난주','관련','등등','에서','으로','하면','하는','대해','대한','까지','부터','으로써','같은','이런','저런','그런','많은','해서','해서는','아니라','아니고','이나','거나','이며','또는','혹은','대한','때문','때문에','약간','정도','최근','지난','기준',
        # 도메인 일반어
        '주가','주식','종목','시장','기업','국내','해외','대한민국','네이버','토론','게시글','댓글','분석','정보','뉴스','기사',
        # 서술/정중 표현
        '있다','있습니다','없다','없습니다','없는','없음','이다','입니다','합니다','했다','합니다만','됩니다','된다','되는','되다','하였다','한다','하는데','같습니다','같아요','네요','예요','에요',
        # 기타 잡음 토큰
        'br','BR'
    ])
    # 흔한 서술어 어미 제거 대상 (어미로 끝나는 단어 배제)
    verb_suffixes = (
        '다','니다','합니다','됩니다','해요','돼요','했어요','했음','했다','한다','되는','된다','이었다','였다','라고','라고요','겠어요','겠음'
    )
    filtered = []
    for t in tokens:
        if len(t) < 2:
            continue
        if t in stopwords:
            continue
        if any(t.endswith(suf) for suf in verb_suffixes):
            continue
        filtered.append(t)
    return filtered

def _count_top_keywords(texts: list, limit: int = 100) -> list:
    from collections import Counter
    tokens_all = []
    for t in texts:
        tokens = _filter_stopwords(_tokenize_korean(t))
        tokens_all.extend(tokens)
    counter = Counter(tokens_all)
    return counter.most_common(limit)

@app.route('/api/discussion')
def discussion_keywords():
    """지난 1개월 토론방 글을 수집하여 상위 키워드 리턴 (네이버 프론트 API 사용)"""
    try:
        base_url = (
            'https://m.stock.naver.com/front-api/discussion/list'
            '?discussionType=domesticStock&itemCode=001530&pageSize=20'
            '&isHolderOnly=false&excludesItemNews=false&isItemNewsOnly=false'
        )
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': 'https://m.stock.naver.com/domestic/stock/001530/discussion'
        }

        cutoff_dt = datetime.now() - timedelta(days=30)
        texts = []
        latest_posts = []
        max_pages = 20
        next_offset = None

        for page_idx in range(max_pages):
            url = base_url if next_offset is None else f"{base_url}&offset={next_offset}"
            resp = requests.get(url, headers=headers, timeout=10)
            if resp.status_code != 200:
                break
            payload = resp.json()
            result = payload.get('result') or {}
            posts = result.get('posts') or []
            if not posts:
                break

            # 텍스트/날짜 수집
            oldest_dt_in_page = None
            for p in posts:
                written_at = p.get('writtenAt')  # ISO 형식
                if written_at:
                    try:
                        dt = datetime.fromisoformat(written_at.replace('Z', '+00:00'))
                    except Exception:
                        dt = None
                else:
                    dt = None
                if dt and (oldest_dt_in_page is None or dt < oldest_dt_in_page):
                    oldest_dt_in_page = dt

                # 제목 + 본문(치환 텍스트)
                title = p.get('title') or ''
                content = p.get('contentSwReplaced') or ''
                if dt is None or dt >= cutoff_dt:
                    texts.append(f"{title} {content}")

            # 첫 페이지에서 최신 3개 포스트 저장
            if page_idx == 0:
                for p in posts[:3]:
                    post_id = p.get('id')
                    latest_posts.append({
                        'title': p.get('title') or '',
                        'content': p.get('contentSwReplaced') or '',
                        'writtenAt': p.get('writtenAt') or '',
                        'url': f"https://m.stock.naver.com/domestic/stock/001530/discussion/{post_id}" if post_id else 'https://m.stock.naver.com/domestic/stock/001530/discussion'
                    })

            # 오래된 페이지까지 내려갔다면 중단
            if oldest_dt_in_page and oldest_dt_in_page < cutoff_dt:
                break

            # 다음 페이지를 위한 offset은 마지막 글의 orderNo 사용
            next_offset = posts[-1].get('orderNo')
            if not next_offset:
                break

        top_keywords = _count_top_keywords(texts, limit=20)
        wc = [[w, int(c)] for w, c in top_keywords if c > 0]

        return jsonify({
            'success': True,
            'keywords': wc,
            'latestPosts': latest_posts
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e),
            'keywords': []
        }), 500

if __name__ == '__main__':
    # 초기 데이터 로드
    print("초기 주가 데이터 로드 중...")
    fetch_stock_data()
    
    # 스케줄러를 별도 스레드에서 실행
    scheduler_thread = threading.Thread(target=run_scheduler, daemon=True)
    scheduler_thread.start()
    
    # Flask 앱 실행
    port = int(os.environ.get('PORT', 8000))
    app.run(host='0.0.0.0', port=port, debug=False)
