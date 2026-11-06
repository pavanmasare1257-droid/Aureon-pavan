// www/video-ui.js — video button: type a description, tap it, AI video banta hai (backend /api/generate-video, saari Gemini keys).
(function () {
  function init() {
    const img = document.getElementById('btn-generate-image');
    if (!img || document.getElementById('btn-generate-video')) return;
    const b = document.createElement('button');
    b.className = img.className; b.id = 'btn-generate-video'; b.innerHTML = ic('video');
    b.title = 'Type a description, then tap to generate a video';
    b.setAttribute('aria-label', 'Generate video');
    img.parentNode.insertBefore(b, img.nextSibling);
    b.onclick = async () => {
      const input = $('chat-input');
      const prompt = input.value.trim();
      if (!prompt) { alert('Pehle likho ki kaisa video chahiye, phir video button dabao.'); return; }
      input.value = '';
      const base = state.backendUrl.replace(/\/$/, '');
      addMessage('user', `Video: ${prompt}`);
      $('typing-indicator').classList.remove('hidden');
      try {
        const start = await fetch(`${base}/api/generate-video`, { method: 'POST', headers: await authHeaders(), body: JSON.stringify({ prompt }) });
        const sd = await start.json();
        if (!start.ok) throw new Error(sd.error || `Server returned ${start.status}`);
        addMessage('ai', UL('Making the video, it takes 1-3 minutes…', 'Video ban raha hai, 1-3 minute lagte hain…'));
        const t0 = Date.now();
        while (Date.now() - t0 < 9 * 60 * 1000) {
          await new Promise((r) => setTimeout(r, 6000));
          const st = await (await fetch(`${base}/api/generate-video/${sd.jobId}`, { headers: await authHeaders() })).json();
          if (st.status === 'error') throw new Error(st.error || 'video fail');
          if (st.status === 'done') {
            const f = await fetch(`${base}/api/generate-video/${sd.jobId}/file`, { headers: await authHeaders() });
            if (!f.ok) throw new Error('video download fail');
            $('typing-indicator').classList.add('hidden');
            addMessage('ai', '', false, null, URL.createObjectURL(await f.blob()));
            return;
          }
        }
        throw new Error('bahut der lag gayi');
      } catch (err) {
        $('typing-indicator').classList.add('hidden');
        addMessage('error', `Couldn't generate that video. ${err.message || ''}`);
      }
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
