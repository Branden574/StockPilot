/**
 * The WCAG 1.4.10 sideways-scroll and heading check a11y-zoom-reflow.spec.ts
 * runs in the page (page.evaluate(reflowInPage)): self-contained, it uses
 * nothing outside its own body. Messages carry no pixel counts so Classic and
 * glass compare by text; the widths go to `measured`.
 *
 * The signed-in pages do not scroll the document: the dashboard shell locks
 * the body and scrolls main#main-content (dashboard-shell.tsx: `flex-1
 * overflow-y-auto`), and overflow-y auto makes overflow-x auto too, so wide
 * content scrolls sideways INSIDE main while the document's scrollWidth
 * never exceeds its clientWidth. So main is measured as well: an element that
 * sticks out past its right edge, outside a data table (a table, role table
 * or grid, or its TableScroll wrapper, which 1.4.10 allows) and outside any
 * box that scrolls or clips on its own, is a failure.
 */
export function reflowInPage(): { out: string[]; measured: string[] } {
  const out: string[] = [];
  const measured: string[] = [];
  const doc = document.scrollingElement ?? document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) {
    out.push('the page scrolls sideways');
    measured.push(`document ${doc.scrollWidth} > ${doc.clientWidth}`);
  }
  // The signed-in pages scroll inside main#main-content: what sticks out past its right edge, outside
  // a data table and outside any box that scrolls or clips on its own, makes the pane scroll sideways.
  const main = document.querySelector<HTMLElement>('main#main-content');
  if (main && main.scrollWidth > main.clientWidth + 1) {
    const right = main.getBoundingClientRect().left + main.clientLeft + main.clientWidth;
    const TABLE =
      'table, [role="table"], [role="grid"], [role="treegrid"], [data-glass="table-scroll"]';
    const culprits: string[] = [];
    for (const el of main.querySelectorAll<HTMLElement>('*')) {
      if (el.closest(TABLE)) continue;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.right <= right + 1) continue;
      let contained = false;
      for (let p = el.parentElement; p && p !== main; p = p.parentElement)
        if (getComputedStyle(p).overflowX !== 'visible') {
          contained = true;
          break;
        }
      if (contained) continue;
      culprits.push(
        `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} right ${Math.round(r.right)} > ${Math.round(right)}`,
      );
      if (culprits.length >= 5) break;
    }
    if (culprits.length) {
      out.push('the main pane scrolls sideways');
      measured.push(`main ${main.scrollWidth} > ${main.clientWidth}: ${culprits.join('; ')}`);
    }
  }
  const h1 = document.querySelector('h1');
  if (h1) {
    const r = h1.getBoundingClientRect();
    if (r.width === 0 || r.left < -1 || r.right > innerWidth + 1)
      out.push('the heading is outside the viewport width');
  }
  return { out, measured };
}
