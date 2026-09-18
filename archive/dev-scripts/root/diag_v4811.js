async page => {
  const out = { step: 'init' };
  await page.goto('http://localhost:8088');
  await page.fill('#lgPw', 'admin123');
  await page.click('#lgGo');
  await page.waitForFunction(() => location.hash.includes('dashboard'), null, { timeout: 12000 });
  out.step = 'login-ok';
  await page.evaluate(() => { location.hash = '#/recon'; });
  await page.waitForTimeout(2500);
  out.url = page.url();
  out.cSupLen = await page.evaluate(() => document.querySelectorAll('#cSup option').length);
  out.cSupVal = await page.evaluate(() => document.querySelector('#cSup') ? document.querySelector('#cSup').value : 'NO_SEL');
  out.agList = (await page.evaluate(() => document.querySelector('#agList') ? document.querySelector('#agList').textContent.slice(0, 80) : 'NO_AG')).trim();
  out.feeList = (await page.evaluate(() => document.querySelector('#feeList') ? document.querySelector('#feeList').textContent.slice(0, 80) : 'NO_FEE')).trim();
  out.cPrevExists = await page.evaluate(() => !!document.querySelector('#cPrev'));
  return JSON.stringify(out);
}
