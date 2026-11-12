function installStudioExternalLinks(token) {
  if (window !== window.top || location.protocol !== 'http:' || location.hostname !== '127.0.0.1') {
    return;
  }
  const openExternal = event => {
    if (!event.isTrusted || event.defaultPrevented || event.button > 1) return;
    const link = event.target instanceof Element && event.target.closest('a[href]');
    if (!link || link.hasAttribute('download')) return;
    const target = new URL(link.href, location.href);
    if (target.protocol !== 'https:' || target.origin === location.origin) return;
    event.preventDefault();
    location.assign('/__studio_desktop_external_link?' + new URLSearchParams({
      token,
      url: target.href,
    }));
  };
  document.addEventListener('click', openExternal, true);
  document.addEventListener('auxclick', openExternal, true);
}
