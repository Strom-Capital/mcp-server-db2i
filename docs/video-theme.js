// The docs show a light and a dark version of each video (className "block dark:hidden"
// and "hidden dark:block" inside a data-video wrapper). When the reader switches the
// theme while one plays, this script, which Mintlify loads on every page, pauses the
// hidden version and continues in the visible one at the same second.
(function () {
  function sync() {
    document.querySelectorAll('[data-video]').forEach((group) => {
      const videos = Array.from(group.querySelectorAll('video'));
      const target = videos.find((video) => video.checkVisibility());
      videos.forEach((video) => {
        if (video === target || (video.paused && video.currentTime === 0)) return;
        const playing = !video.paused;
        video.pause();
        if (!target) return;
        target.currentTime = video.currentTime;
        target.muted = video.muted;
        target.volume = video.volume;
        if (video.textTracks[0] && target.textTracks[0]) target.textTracks[0].mode = video.textTracks[0].mode;
        if (playing) target.play().catch(() => {});
      });
    });
  }

  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
})();
