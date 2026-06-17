require("dotenv").config();
const fs = require("fs");
const { chromium } = require("playwright");
const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");

const JOBS_URL = process.env.JOBS_URL;
const MAX_APPS = Number(process.env.MAX_APPS || 20);
const PHONE = process.env.PHONE || "";
const CV_PATH = process.env.CV_PATH || "";
const STORAGE = "linkedin-auth.json";
const ANSWERS_FILE = "known-answers.json";

function loadKnownAnswers() {
  const fallback = [
    {
      pattern: "what\\s+is\\s+your\\s+current\\s+location|current\\s+location|localiza[cç][aã]o\\s+atual",
      answer: "Vila Velha",
    },
  ];

  if (!fs.existsSync(ANSWERS_FILE)) {
    console.log(`Arquivo ${ANSWERS_FILE} nao encontrado. Usando respostas padrao.`);
    return fallback;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(ANSWERS_FILE, "utf8"));
    if (!Array.isArray(parsed)) {
      console.log(`Arquivo ${ANSWERS_FILE} invalido. Usando respostas padrao.`);
      return fallback;
    }

    const valid = parsed.filter(
      (item) => item && typeof item.pattern === "string" && typeof item.answer === "string"
    );

    if (!valid.length) {
      console.log(`Arquivo ${ANSWERS_FILE} sem regras validas. Usando respostas padrao.`);
      return fallback;
    }

    console.log(`Carregadas ${valid.length} respostas de ${ANSWERS_FILE}.`);
    return valid;
  } catch (error) {
    console.log(`Falha ao ler ${ANSWERS_FILE}. Usando respostas padrao.`);
    return fallback;
  }
}

const KNOWN_ANSWERS = loadKnownAnswers();

async function askEnter(message) {
  const rl = readline.createInterface({ input, output });
  await rl.question(`${message}\nPressione ENTER para continuar...`);
  rl.close();
}

async function closeModalIfOpen(page) {
  const dismiss = page.getByRole("button", { name: /descartar|discard/i }).first();
  if (await dismiss.isVisible().catch(() => false)) {
    await dismiss.click().catch(() => {});
    const confirm = page.getByRole("button", { name: /descartar|discard/i }).nth(1);
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click().catch(() => {});
    }
  }
}

async function getJobCards(page) {
  const selectors = [
    "ul.jobs-search__results-list li",
    "li.jobs-search-results__list-item",
    "div.jobs-search-results-list ul li",
    "li:has(div.job-card-container)",
    "div[data-job-id]",
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count > 0) {
      return { locator, count, selector };
    }
  }

  return null;
}

async function fillKnownQuestions(page) {
  const filled = await page.evaluate((rules) => {
    function normalize(text) {
      return (text || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim();
    }

    function getQuestionText(element) {
      const parts = [];
      const ariaLabel = element.getAttribute("aria-label");
      const placeholder = element.getAttribute("placeholder");
      const name = element.getAttribute("name");
      const id = element.id;

      if (ariaLabel) {
        parts.push(ariaLabel);
      }
      if (placeholder) {
        parts.push(placeholder);
      }
      if (name) {
        parts.push(name);
      }
      if (id) {
        const linkedLabel = document.querySelector(`label[for="${id}"]`);
        if (linkedLabel?.textContent) {
          parts.push(linkedLabel.textContent);
        }
      }

      const nearLabel =
        element.closest(".fb-dash-form-element")?.querySelector("label") ||
        element.closest(".jobs-easy-apply-form-section")?.querySelector("label");
      if (nearLabel?.textContent) {
        parts.push(nearLabel.textContent);
      }

      return normalize(parts.join(" "));
    }

    function isVisible(el) {
      if (!(el instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && el.offsetParent !== null;
    }

    const compiledRules = rules.map((r) => ({
      regex: new RegExp(normalize(r.pattern), "i"),
      answer: r.answer,
      pattern: r.pattern,
    }));

    const elements = Array.from(document.querySelectorAll("input, textarea, select"));
    const changes = [];

    for (const element of elements) {
      if (!isVisible(element)) {
        continue;
      }

      if (element instanceof HTMLInputElement) {
        const t = (element.type || "text").toLowerCase();
        if (["hidden", "file", "checkbox", "radio", "submit", "button"].includes(t)) {
          continue;
        }
      }

      const question = getQuestionText(element);
      if (!question) {
        continue;
      }

      const rule = compiledRules.find((r) => r.regex.test(question));
      if (!rule) {
        continue;
      }

      const currentValue = (element.value || "").trim();
      if (currentValue) {
        continue;
      }

      if (element instanceof HTMLSelectElement) {
        const exact = Array.from(element.options).find((opt) => normalize(opt.textContent) === normalize(rule.answer));
        const contains = Array.from(element.options).find((opt) => normalize(opt.textContent).includes(normalize(rule.answer)));
        const option = exact || contains;
        if (!option) {
          continue;
        }
        element.value = option.value;
      } else {
        element.value = rule.answer;
      }

      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      changes.push({ question, answer: rule.answer, pattern: rule.pattern });
    }

    return changes;
  }, KNOWN_ANSWERS);

  for (const item of filled) {
    console.log(`Resposta automatica aplicada: "${item.answer}".`);
  }
}

async function clickFirstVisibleEnabled(locators) {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const candidate = locator.nth(i);
      const isVisible = await candidate.isVisible().catch(() => false);
      if (!isVisible) {
        continue;
      }

      const isEnabled = await candidate.isEnabled().catch(() => true);
      if (!isEnabled) {
        continue;
      }

      const clicked = await candidate.click({ timeout: 2000 }).then(() => true).catch(() => false);
      if (clicked) {
        return true;
      }
    }
  }

  return false;
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless: false,
      slowMo: 250,
    });
    console.log("Navegador iniciado com Google Chrome.");
  } catch (error) {
    console.log("Nao foi possivel iniciar com Google Chrome. Usando Chromium.");
    browser = await chromium.launch({ headless: false, slowMo: 250 });
  }
  const context = await browser.newContext(
    fs.existsSync(STORAGE) ? { storageState: STORAGE } : {}
  );
  const page = await context.newPage();

  await page.goto("https://www.linkedin.com/", { waitUntil: "domcontentloaded" });

  if (!fs.existsSync(STORAGE)) {
    await askEnter("Faça login no LinkedIn manualmente.");
    await context.storageState({ path: STORAGE });
  }

  await page.goto(JOBS_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  let applied = 0;
  let cards = null;
  let total = 0;

  for (let attempt = 1; attempt <= 8; attempt++) {
    const result = await getJobCards(page);
    if (result) {
      cards = result.locator;
      total = result.count;
      console.log(`Encontradas ${total} vagas na lista atual (seletor: ${result.selector}).`);
      break;
    }

    await page.evaluate(() => {
      window.scrollBy(0, 1200);
      const listPanel = document.querySelector(".jobs-search-results-list");
      if (listPanel) {
        listPanel.scrollTop = listPanel.scrollHeight;
      }
    }).catch(() => {});
    await page.waitForTimeout(1200);
  }

  if (!cards || total === 0) {
    const currentUrl = page.url();
    const title = await page.title().catch(() => "sem titulo");
    console.log("Nao encontrei cards de vaga na pagina.");
    console.log(`URL atual: ${currentUrl}`);
    console.log(`Titulo da pagina: ${title}`);
    await context.storageState({ path: STORAGE });
    return;
  }

  for (let i = 0; i < total && applied < MAX_APPS; i++) {
    const card = cards.nth(i);
    await card.click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const easyApply = page.getByRole("button", {
      name: /candidatura simplificada|easy apply/i,
    }).first();

    if (!(await easyApply.isVisible().catch(() => false))) {
      continue;
    }

    await easyApply.click().catch(() => {});
    await page.waitForTimeout(1200);

    const phoneInput = page.locator("input[type='tel']").first();
    if (PHONE && (await phoneInput.isVisible().catch(() => false))) {
      const current = await phoneInput.inputValue().catch(() => "");
      if (!current) {
        await phoneInput.fill(PHONE).catch(() => {});
      }
    }

    const fileInput = page.locator("input[type='file']").first();
    if (CV_PATH && fs.existsSync(CV_PATH) && (await fileInput.isVisible().catch(() => false))) {
      await fileInput.setInputFiles(CV_PATH).catch(() => {});
    }

    await fillKnownQuestions(page);

    let steps = 0;
    let submitted = false;
    while (steps < 7) {
      await fillKnownQuestions(page);

      const clickedReview = await clickFirstVisibleEnabled([
        page.getByRole("button", { name: /revisar|review|revise/i }),
        page.locator("button:has-text('Revisar')"),
        page.locator("button:has-text('Review')"),
        page.locator("[role='button']:has-text('Revisar')"),
        page.locator("[role='button']:has-text('Review')"),
      ]);

      if (clickedReview) {
        console.log("Etapa: clicou em Revisar.");
        await page.waitForTimeout(1100);
        steps++;
        continue;
      }

      const clickedNext = await clickFirstVisibleEnabled([
        page.getByRole("button", {
          name: /pr[óo]xima|next|continuar|continue|avancar|avançar/i,
        }),
        page.locator("button:has-text('Próxima')"),
        page.locator("button:has-text('Proxima')"),
        page.locator("button:has-text('Next')"),
        page.locator("button:has-text('Continuar')"),
        page.locator("button:has-text('Continue')"),
      ]);

      if (clickedNext) {
        console.log("Etapa: clicou em Proxima/Continuar.");
        await page.waitForTimeout(900);
        steps++;
        continue;
      }

      const submitBtn = page.getByRole("button", {
        name: /enviar candidatura|submit application/i,
      }).first();

      if (await submitBtn.isVisible().catch(() => false)) {
        await askEnter(`Revise a candidatura #${applied + 1}.`);
        await submitBtn.click().catch(() => {});
        submitted = true;
        applied++;
        console.log(`OK: candidatura enviada (${applied}/${MAX_APPS})`);
        break;
      }

      break;
    }

    if (!submitted) {
      console.log(`Pulada vaga ${i + 1}: fluxo complexo ou sem botão final.`);
      await closeModalIfOpen(page);
    } else {
      const done = page.getByRole("button", { name: /concluído|done/i }).first();
      if (await done.isVisible().catch(() => false)) {
        await done.click().catch(() => {});
      }
    }

    await page.waitForTimeout(1000);
  }

  await context.storageState({ path: STORAGE });
  console.log(`Finalizado. Total enviado: ${applied}`);
})();
