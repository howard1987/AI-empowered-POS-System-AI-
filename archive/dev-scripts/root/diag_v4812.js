async page => {
  const out = {};
  await page.goto('http://localhost:8088', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  out.preSide = await page.evaluate(() => {
    const s = document.getElementById('side');
    return s ? getComputedStyle(s).display : 'no-el';
  });
  out.viewText = await page.evaluate(() => (document.getElementById('view')?.textContent || '').slice(0, 120));
  await page.screenshot({ path: 'shot-v4812-diag1.png' }).catch(() => {});
  if (out.preSide === 'none') {
    await page.fill('#lgNo', 'ADMIN');
    await page.fill('#lgPw', 'admin123');
    await page.click('#lgGo');
    await page.waitForTimeout(3500);
    out.postSide = await page.evaluate(() => {
      const s = document.getElementById('side');
      return s ? getComputedStyle(s).display : 'no-el';
    });
    out.lgErr = await page.evaluate(() => document.getElementById('lgErr')?.textContent || '');
    await page.screenshot({ path: 'shot-v4812-diag2.png' }).catch(() => {});
  }
  await page.evaluate(() => { location.hash = '#/purchase'; });
  await page.waitForTimeout(4000);
  out.hash = await page.evaluate(() => location.hash);
  out.purchaseHasSup = await page.evaluate(() => !!document.querySelector('#iSup option'));
  out.viewText2 = await page.evaluate(() => (document.getElementById('view')?.textContent || '').slice(0, 200));
  await page.screenshot({ path: 'shot-v4812-diag3.png' }).catch(() => {});
  return out;
}
