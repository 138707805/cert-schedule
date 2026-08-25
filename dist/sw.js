const CACHE = "cert-schedule-v2";
const SHELL = ["./index.html", "./style.css", "./app.js", "./manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// 네트워크 우선: 온라인이면 항상 최신 파일을 받아오고, 그 결과를 캐시에 갱신해둔다.
// 오프라인일 때만 마지막으로 저장해둔 캐시를 사용한다 (예전 버전에 영영 갇히는 문제 방지).
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return; // API는 항상 네트워크로

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, resClone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
