// AI 학습 기록 서버: 확장 프로그램이 보낸 영상을 받아 "AI 관련 여부 판별 + 학습 정리"를 하고 저장한다.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const API_KEY = process.env.ANTHROPIC_API_KEY;
const DATA_FILE = path.join(__dirname, 'data', 'videos.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- 저장소 (JSON 파일) ----------
let videos = {};
try {
  videos = JSON.parse(await readFile(DATA_FILE, 'utf8'));
} catch {}

let saving = Promise.resolve();
function save() {
  saving = saving.then(async () => {
    await mkdir(path.dirname(DATA_FILE), { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify(videos, null, 2));
  });
  return saving;
}

// ---------- AI 분석 ----------
const PROMPT = `당신은 AI 공부를 돕는 학습 정리 도우미입니다.
아래 유튜브 영상 정보를 보고 JSON만 출력하세요(설명, 코드블록 금지).

"AI 관련"의 기준: 생성형 AI, LLM, 머신러닝/딥러닝, AI 도구·서비스 활용, 프롬프트, AI 에이전트, AI 코딩, AI 업계 동향 등 AI를 배우거나 활용하는 내용.
단순히 제목에 AI가 들어갔지만 내용이 무관한 경우는 false.

형식:
{
  "isAiRelated": true | false,
  "summary": "핵심 내용 3~5문장 요약 (한국어)",
  "terms": [{"term": "용어", "definition": "한 줄 설명"}],
  "usage": ["실제로 활용할 수 있는 방법/팁"],
  "tags": ["주제 태그 3~6개, 짧은 명사"]
}
isAiRelated가 false이면 나머지 필드는 빈 값으로 두세요.`;

async function analyze(v) {
  const transcript = (v.transcript || '').slice(0, 30000);
  const content = `${PROMPT}

[제목] ${v.title}
[채널] ${v.channel}
[설명] ${(v.description || '').slice(0, 2000)}
[자막] ${transcript || '(자막 없음 — 제목/설명으로만 판단)'}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const text = body.content?.find((b) => b.type === 'text')?.text ?? '';
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(json);
}

async function processVideo(id) {
  const v = videos[id];
  if (!v) return;
  try {
    const r = await analyze(v);
    if (!r.isAiRelated) {
      // AI와 무관한 영상은 본문(자막 등)을 버리고 "무관" 표시만 남겨 재분석을 막는다.
      videos[id] = { id, title: v.title, channel: v.channel, watchedAt: v.watchedAt, status: 'done', isAiRelated: false };
    } else {
      Object.assign(videos[id], {
        status: 'done',
        isAiRelated: true,
        summary: r.summary,
        terms: r.terms || [],
        usage: r.usage || [],
        tags: (r.tags || []).map((t) => String(t).trim()).filter(Boolean),
      });
      delete videos[id].transcript; // 자막 원문은 용량이 커서 분석 후 삭제
    }
    delete videos[id].error;
  } catch (err) {
    videos[id].status = 'error';
    videos[id].error = String(err.message || err).slice(0, 300);
    console.error(`[분석 실패] ${v.title}: ${videos[id].error}`);
  }
  await save();
}

// 분석을 한 번에 하나씩 순서대로 처리
let queue = Promise.resolve();
function enqueue(id) {
  queue = queue.then(() => processVideo(id));
}

// ---------- HTTP ----------
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 5_000_000) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // 영상 수신 (확장 프로그램). JSON 전용이라 다른 웹사이트의 임의 요청은 CORS 사전요청에서 막힌다.
    if (req.method === 'POST' && url.pathname === '/api/videos') {
      if (!req.headers['content-type']?.includes('application/json')) return send(res, 415, { error: 'json only' });
      const b = await readJson(req);
      if (!/^[\w-]{11}$/.test(b.videoId || '')) return send(res, 400, { error: 'bad videoId' });
      const existing = videos[b.videoId];
      if (existing && existing.status !== 'error') return send(res, 200, { status: 'duplicate' });
      videos[b.videoId] = {
        id: b.videoId,
        title: String(b.title || '').slice(0, 300),
        channel: String(b.channel || '').slice(0, 200),
        description: String(b.description || '').slice(0, 5000),
        transcript: String(b.transcript || ''),
        hasTranscript: Boolean(b.transcript),
        watchedAt: new Date().toISOString(),
        status: API_KEY ? 'pending' : 'no_key',
      };
      await save();
      if (API_KEY) enqueue(b.videoId);
      return send(res, 202, { status: videos[b.videoId].status });
    }

    // 목록: AI 관련 영상 + 처리 중/오류 건 (AI 무관 영상은 숨김)
    if (req.method === 'GET' && url.pathname === '/api/videos') {
      const list = Object.values(videos)
        .filter((v) => v.isAiRelated !== false)
        .map(({ transcript, description, ...rest }) => rest)
        .sort((a, b) => b.watchedAt.localeCompare(a.watchedAt));
      const skipped = Object.values(videos).filter((v) => v.isAiRelated === false).length;
      return send(res, 200, { videos: list, skipped, analysisEnabled: Boolean(API_KEY) });
    }

    // 실패/키 없음 상태 재분석
    if (req.method === 'POST' && url.pathname === '/api/reanalyze') {
      if (!API_KEY) return send(res, 400, { error: 'ANTHROPIC_API_KEY 가 설정되지 않았습니다' });
      let n = 0;
      for (const v of Object.values(videos)) {
        if (v.status === 'error' || v.status === 'no_key') {
          v.status = 'pending';
          enqueue(v.id);
          n++;
        }
      }
      await save();
      return send(res, 202, { queued: n });
    }

    // 대시보드 정적 파일
    if (req.method === 'GET') {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const full = path.join(PUBLIC_DIR, file);
      if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
      try {
        const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
        return send(res, 200, await readFile(full), type);
      } catch {
        return send(res, 404, 'not found', 'text/plain');
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 500, { error: String(err.message || err) });
  }
});

// 내 PC에서만 접속 가능하도록 로컬 주소에만 바인딩
server.listen(PORT, '127.0.0.1', () => {
  console.log(`AI 학습 기록 → http://localhost:${PORT}`);
  if (!API_KEY) console.log('⚠ ANTHROPIC_API_KEY 가 없어 영상은 저장만 되고 분석은 되지 않습니다. (.env 설정 후 재시작)');
  for (const v of Object.values(videos)) if (v.status === 'pending') enqueue(v.id);
});
