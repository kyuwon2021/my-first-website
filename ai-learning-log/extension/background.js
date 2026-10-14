// 시청 알림을 받으면 영상 정보(제목/채널/설명/자막)를 가져와 로컬 서버로 보낸다.
const SERVER = 'http://localhost:3000';

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'watched') collectAndSend(msg.videoId).catch((e) => console.warn('[AI 학습 기록]', e));
});

// "marker" 뒤에 오는 JSON 객체 하나를 중괄호 짝을 맞춰 잘라낸다.
function extractJson(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  return null;
}

async function fetchTranscript(tracks) {
  if (!tracks?.length) return '';
  const pick = (l) => tracks.find((t) => t.languageCode?.startsWith(l));
  const track = pick('ko') || pick('en') || tracks[0];
  try {
    const res = await fetch(track.baseUrl + '&fmt=json3');
    if (!res.ok) return '';
    const data = await res.json();
    return (data.events || [])
      .flatMap((e) => (e.segs || []).map((s) => s.utf8))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return ''; // 자막을 못 가져오면 제목/설명만으로 분석한다
  }
}

async function collectAndSend(videoId) {
  const page = await (await fetch(`https://www.youtube.com/watch?v=${videoId}`, { credentials: 'include' })).text();
  const player = extractJson(page, 'ytInitialPlayerResponse');
  const details = player?.videoDetails;
  if (!details) return;
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  const body = {
    videoId,
    title: details.title,
    channel: details.author,
    description: details.shortDescription,
    transcript: await fetchTranscript(tracks),
  };
  const res = await fetch(`${SERVER}/api/videos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log('[AI 학습 기록]', details.title, res.status);
}
