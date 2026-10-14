// 유튜브 시청 감지: 영상을 실제로 재생한 시간이 MIN_WATCH_SECONDS 를 넘으면 한 번만 background 로 알린다.
const MIN_WATCH_SECONDS = 30;
const watched = new Map(); // videoId -> 재생 누적 초
const reported = new Set();

function currentVideoId() {
  if (location.pathname !== '/watch') return null;
  return new URLSearchParams(location.search).get('v');
}

setInterval(() => {
  const id = currentVideoId();
  const video = document.querySelector('video');
  if (!id || !video || video.paused || reported.has(id)) return;
  const sec = (watched.get(id) || 0) + 1;
  watched.set(id, sec);
  if (sec >= MIN_WATCH_SECONDS) {
    reported.add(id);
    chrome.runtime.sendMessage({ type: 'watched', videoId: id });
  }
}, 1000);
