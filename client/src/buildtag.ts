/*
 The commit the running bundle was built from, so a deploy can be checked at a
 glance. build.sh and the image write static/version.txt; a local run without
 that file leaves the label hidden.
*/
export function paintBuildTag(): void {
  const el = document.getElementById('buildtag');
  if (!el) return;
  void fetch('/version.txt')
    .then((res) => (res.ok ? res.text() : ''))
    .then((text) => {
      const build = text.trim();
      if (!build || build === 'unknown') return;
      el.textContent = 'build ' + build;
      el.hidden = false;
    })
    .catch(() => {});
}
