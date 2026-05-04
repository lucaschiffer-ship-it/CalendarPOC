const puppeteer = require('puppeteer');

const BASE_URL     = 'https://spaces.kisd.de';
const FILTERED_URL = `${BASE_URL}/course-selection/?semester=2026-1&mycourses=on`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser = null;
let page    = null;

async function getOrCreatePage(userDataDir) {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      userDataDir,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    page = null;
  }

  if (!page || page.isClosed()) {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    // Block the MFA page's auto-submit: the IDPLogin form fires document.IDPLogin.submit()
    // on page load with an empty nffc field, consuming an OTP attempt before the user
    // can type the real code. Patch submit() to ignore calls where nffc is empty.
    await page.evaluateOnNewDocument(() => {
      const _orig = HTMLFormElement.prototype.submit;
      HTMLFormElement.prototype.submit = function () {
        const nffc = this.elements && this.elements['nffc'];
        if (nffc !== undefined && nffc.value === '') return;
        return _orig.call(this);
      };
    });
  }

  return page;
}

async function login(page, username, password, requestMfaCode) {
  console.log('[scraper] login — navigating to portal…');
  await page.goto(`${BASE_URL}/public/`, { waitUntil: 'networkidle2', timeout: 45000 });
  console.log('[scraper] login — landed on:', page.url());

  const samlLink = await page.$('#saml-login-link, a[title="TH Login"]');
  if (!samlLink) throw new Error('SAML login link not found on portal page.');

  console.log('[scraper] login — clicking TH Login (SAML)…');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }),
    samlLink.click(),
  ]);
  console.log('[scraper] login — redirected to:', page.url());

  const idpInputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map((i) => ({
      type: i.type, name: i.name, id: i.id,
    }))
  );
  console.log('[scraper] login — IdP inputs:', JSON.stringify(idpInputs));

  const userEl = await page.$('input[name="Ecom_User_ID"], input[name="username"], input[name="user"], #username, input[type="text"]');
  const passEl = await page.$('input[name="Ecom_Password"], input[name="password"], input[name="pass"], #password, input[type="password"]');

  if (!userEl) throw new Error('Username field not found on IdP page.');
  if (!passEl) throw new Error('Password field not found on IdP page.');

  await userEl.click({ clickCount: 3 });
  await userEl.type(username, { delay: 30 });
  await passEl.click({ clickCount: 3 });
  await passEl.type(password, { delay: 30 });

  console.log('[scraper] login — submitting IdP form…');
  await page.keyboard.press('Enter');

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
  console.log('[scraper] login — after credentials hop 1:', page.url());

  if (!page.url().includes('spaces.kisd.de') &&
      !page.url().includes('mfa.th-koeln.de') &&
      !page.url().includes('/osp/')) {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    console.log('[scraper] login — after credentials hop 2:', page.url());
  }

  if (page.url().includes('mfa.th-koeln.de') || page.url().includes('/osp/')) {
    console.log('[scraper] login — MFA required, requesting code from UI…');
    if (!requestMfaCode) throw new Error('MFA required but no handler provided.');

    const mfaCode = await requestMfaCode();
    console.log('[scraper] login — MFA code received, entering…');

    // MFA field confirmed: id="nffc", type="password" (TH Köln NetIQ IdP)
    // After OTP submit, the chain is:
    //   mfa.th-koeln.de/osp/... → login.th-koeln.de/nidp/saml2/sso?sid=0
    //   → auto-submit SAML assertion → spaces.kisd.de
    await page.waitForSelector('#nffc', { timeout: 10000 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      page.evaluate((code) => {
        document.getElementById('nffc').value = code;
        document.IDPLogin.submit();
      }, mfaCode),
    ]);
    console.log('[scraper] login — after MFA hop 1:', page.url());

    if (!page.url().includes('spaces.kisd.de')) {
      require('fs').writeFileSync('/tmp/kisd-saml-sid0.html', await page.content());
      console.log('[scraper] login — saved sid=0 HTML to /tmp/kisd-saml-sid0.html');

      const formInfo = await page.evaluate(() =>
        Array.from(document.forms).map((f) => ({
          id: f.id, name: f.name, action: f.action, method: f.method,
          inputs: Array.from(f.elements).map((e) => ({ tag: e.tagName, type: e.type, name: e.name })),
        }))
      );
      console.log('[scraper] login — forms on sid=0 page:', JSON.stringify(formInfo));

      const submitted = await page.evaluate(() => {
        const f = document.forms[0];
        if (f) { f.submit(); return true; }
        return false;
      });
      console.log('[scraper] login — sid=0 form submitted:', submitted);

      if (submitted) {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        console.log('[scraper] login — after sid=0 submit:', page.url());
      }
    }
  }

  const urlAfterLogin = page.url();
  console.log('[scraper] login — final URL:', urlAfterLogin, '| title:', await page.title());

  if (!urlAfterLogin.includes('spaces.kisd.de')) {
    const errorMsg = await page.evaluate(() => {
      const el = document.querySelector('.login-error, #login_error, .message, .error, #error');
      return el ? el.innerText : null;
    });
    throw new Error(`Login failed — still on login page. Error: ${errorMsg || 'none visible'}`);
  }

  // Prime the course-selection subsite (WordPress multisite needs a per-subsite session cookie)
  console.log('[scraper] login — priming course-selection subsite…');
  await page.goto(`${BASE_URL}/course-selection/`, { waitUntil: 'networkidle2', timeout: 45000 });
  await sleep(2000);
}

async function scrapeKISD(username, password, userDataDir, requestMfaCode) {
  const page = await getOrCreatePage(userDataDir);

  await page.goto(
    'https://spaces.kisd.de/course-selection/?semester=2026-1&mycourses=on',
    { waitUntil: 'domcontentloaded', timeout: 15000 }
  );

  const isLoggedIn = await page.evaluate(() =>
    document.body.classList.contains('logged-in')
  );
  console.log('[scraper] Already logged in:', isLoggedIn);

  if (!isLoggedIn) {
    await login(page, username, password, requestMfaCode);
  }

  // Prime the course-selection subsite, then load the filtered URL
  await page.goto(`${BASE_URL}/course-selection/`, { waitUntil: 'networkidle2', timeout: 15000 });
  await new Promise(r => setTimeout(r, 2000));
  await page.goto(FILTERED_URL, { waitUntil: 'networkidle2', timeout: 15000 });

  // Wait for either course cards or the "no posts" empty state to appear
  await page.waitForFunction(() => {
    const cards = document.querySelectorAll('article.card, .card[data-post-url], .course-card');
    const empty = document.querySelector('.subheader h4');
    return cards.length > 0 || !!empty;
  }, { timeout: 15000 }).catch(() => {});

  const bodyClass = await page.evaluate(() => document.body.className);
  console.log('[BODY CLASS]', bodyClass);

  const swapHtml = await page.evaluate(() =>
    document.querySelector('#tertiary-swap-container, #swap-container')?.innerHTML?.slice(0, 1000)
  );
  console.log('[SWAP HTML]', swapHtml);

  require('fs').writeFileSync('/tmp/kisd-current.html', await page.content());
  console.log('[DEBUG] saved to /tmp/kisd-current.html');

  const courses = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('article.card.course')).map((el) => {
      const h1 = el.querySelector('h1[title]');
      const title = h1
        ? h1.getAttribute('title')
        : (el.querySelector('h1')?.textContent.trim() || 'Untitled');

      const courseType =
        el.querySelector('.info-chip-course_type .value')?.textContent.trim() || null;

      const lecturers = [...new Set(
        Array.from(el.querySelectorAll('.avatar-name'))
          .map((e) => e.textContent.trim()).filter(Boolean)
      )];

      let timeframe = null, meetingTimes = null, location = null, description = null;
      for (const label of el.querySelectorAll('.info-label')) {
        const key     = label.textContent.trim();
        const content = label.parentElement?.querySelector('.info-content');
        if (!content) continue;
        if (key === 'Timeframe')
          timeframe = content.textContent.replace(/\s+/g, ' ').trim();
        if (key === 'Meeting Times')
          meetingTimes = content.innerHTML
            .replace(/<br\s*\/?>/gi, ' · ').replace(/<[^>]+>/g, '')
            .replace(/\s*·\s*/g, ' · ').replace(/\s+/g, ' ').trim();
        if (key === 'Location')
          location = content.textContent.replace(/\s+/g, ' ').trim();
        if (key === 'Description')
          description = content.textContent.replace(/\s+/g, ' ').trim();
      }

      return {
        title, courseType, lecturers,
        timeframe, meetingTimes, location, description,
        courseUrl: el.getAttribute('data-post-url') || null,
      };
    });
  });

  console.log(`[scraper] Found ${courses.length} course(s).`);
  return courses;
}

async function resetBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    page = null;
  }
}

module.exports = { scrapeKISD, resetBrowser };
