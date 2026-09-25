// The guides link to each other as `security.md#anchor`, which works when they
// are read on GitHub. On the documentation site the page is `/security`, so
// this script, which Mintlify loads on every page, maps those links to the page
// route: it rewrites each href (hover, new tab, copy link) and handles clicks
// before the site's router sees the `.md` path.
(function () {
  function toPageUrl(href) {
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null;
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.endsWith('.md')) return null;
    return url.pathname.slice(0, -3) + url.search + url.hash;
  }

  document.addEventListener(
    'click',
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!link || (link.target && link.target !== '_self')) return;
      const pageUrl = toPageUrl(link.getAttribute('href')) || toPageUrl(link.dataset.mdHref);
      if (!pageUrl) return;
      event.preventDefault();
      event.stopPropagation();
      window.location.assign(pageUrl);
    },
    true
  );

  // React can put the original href back when it re-renders a page, so keep
  // the original in data-md-href for the click handler and rewrite on changes.
  function rewriteAll() {
    document.querySelectorAll('a[href$=".md"], a[href*=".md#"], a[href*=".md?"]').forEach((link) => {
      const href = link.getAttribute('href');
      const pageUrl = toPageUrl(href);
      if (!pageUrl) return;
      link.dataset.mdHref = href;
      link.setAttribute('href', pageUrl);
    });
  }

  rewriteAll();
  new MutationObserver(rewriteAll).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['href'],
  });
})();
