async page => {
  const out = {};
  await page.goto('http://localhost:8089');
  // 登录
  await page.click('.tab[data-t=login]');
  await page.fill('#fLogin [name=phone]', '13811112222');
  await page.fill('#fLogin [name=password]', 'abc123');
  await page.click('#fLogin button[type=submit]');
  await page.waitForSelector('#main:not([hidden])', { timeout: 9000 });
  out.login = 'OK';
  // 进充值页
  await page.click('.nav-b[data-v=recharge]');
  await page.waitForSelector('#rechargePlans .plan', { timeout: 9000 });
  out.plans = (await page.textContent('#rechargePlans')).trim();
  // 直接调 API 试探
  const probe = await page.evaluate(async () => {
    const r = await fetch('http://localhost:3100/m/recharge-orders', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + localStorage.getItem('h5_token'), 'content-type': 'application/json' },
      body: JSON.stringify({ planId: Number(document.querySelector('#rechargePlans .plan').dataset.id) }),
    });
    return await r.json();
  });
  out.probe = JSON.stringify(probe);
  out.tokenSet = !!(await page.evaluate(() => localStorage.getItem('h5_token')));
  return JSON.stringify(out).slice(0, 600);
}
