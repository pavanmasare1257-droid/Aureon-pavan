/* Connects the Digital Twin panel (twin.js) to Aureon: backend URL + the signed-in user's token, and the Settings row that opens it. */
(function () {
  function init() {
    if (!window.AureonTwin) return;
    window.AureonTwin.init({
      // the twin routes live under /api/twin/* on Aureon's backend
      apiBase: String((typeof state !== 'undefined' && state.backendUrl) || 'https://aureone.onrender.com').replace(/\/$/, '') + '/api',
      getIdToken: function () {
        if (typeof state === 'undefined' || !state.user) return Promise.reject(new Error('Please sign in first'));
        return state.user.getIdToken();
      },
    });
  }
  function wire() {
    var b = document.getElementById('twin-open-row');
    if (b && !b._w) {
      b._w = 1;
      b.addEventListener('click', function () { init(); window.AureonTwin.open(); });
    }
  }
  document.addEventListener('DOMContentLoaded', wire);
  if (document.readyState !== 'loading') wire();
})();
