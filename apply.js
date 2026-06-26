require("dotenv").config();
const fs = require("fs");
const { chromium } = require("playwright");
const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");

const JOBS_URL = process.env.JOBS_URL;
const MAX_APPS = Number(process.env.MAX_APPS || 20);
const SKIP_JOBS = Math.max(0, Number(process.env.SKIP_JOBS || 0));
const PHONE = process.env.PHONE || "";
const CV_PATH = process.env.CV_PATH || "";
const STORAGE = "linkedin-auth.json";
const ANSWERS_FILE = "known-answers.json";

function loadKnownAnswers() {
  const fallback = [
    {
      pattern:
        "what\\s+is\\s+your\\s+current\\s+location|current\\s+location|localiza[cç][aã]o\\s+atual|city|cidade",
      answer: "Vila Velha, ES",
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

function normalizeText(value) {
  return (value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const COMPILED_KNOWN_ANSWERS = KNOWN_ANSWERS.map((rule) => ({
  ...rule,
  regex: new RegExp(normalizeText(rule.pattern), "i"),
}));

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

      const fieldsetLegend = element.closest("fieldset")?.querySelector("legend");
      if (fieldsetLegend?.textContent) {
        parts.push(fieldsetLegend.textContent);
      }

      return normalize(parts.join(" "));
    }

    function getRadioOptionText(input) {
      const parts = [];
      const id = input.id;

      if (input.value) {
        parts.push(input.value);
      }

      if (id) {
        const explicitLabel = document.querySelector(`label[for="${id}"]`);
        if (explicitLabel?.textContent) {
          parts.push(explicitLabel.textContent);
        }
      }

      const wrapLabel = input.closest("label");
      if (wrapLabel?.textContent) {
        parts.push(wrapLabel.textContent);
      }

      const optionContainer =
        input.closest(".fb-form-element__option") ||
        input.closest(".jobs-easy-apply-form-element") ||
        input.parentElement;
      if (optionContainer?.textContent) {
        parts.push(optionContainer.textContent);
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
    const handledRadioGroups = new Set();

    for (const element of elements) {
      const isRadioInput =
        element instanceof HTMLInputElement && (element.type || "").toLowerCase() === "radio";

      if (!isRadioInput && !isVisible(element)) {
        continue;
      }

      if (element instanceof HTMLInputElement) {
        const t = (element.type || "text").toLowerCase();
        if (["hidden", "file", "checkbox", "submit", "button"].includes(t)) {
          continue;
        }

        const role = (element.getAttribute("role") || "").toLowerCase();
        const autoComplete = (element.getAttribute("aria-autocomplete") || "").toLowerCase();
        if (role === "combobox" || autoComplete === "list") {
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
      if (!isRadioInput && currentValue) {
        continue;
      }

      if (isRadioInput) {
        const radio = element;
        const answerNormalized = normalize(rule.answer);
        const groupKey = radio.name || radio.id || question;

        if (handledRadioGroups.has(groupKey)) {
          continue;
        }
        handledRadioGroups.add(groupKey);

        let radios = [];
        if (radio.name) {
          radios = Array.from(document.querySelectorAll('input[type="radio"]')).filter(
            (r) => r.name === radio.name
          );
        }
        if (!radios.length) {
          radios = [radio];
        }

        const optionMatch = radios.find((r) => {
          const optionText = getRadioOptionText(r);
          return optionText === answerNormalized || optionText.includes(answerNormalized);
        });

        const target = optionMatch || radios.find((r) => normalize(r.value) === answerNormalized);
        if (!target) {
          continue;
        }

        const targetId = target.id;
        const targetLabel = targetId ? document.querySelector(`label[for="${targetId}"]`) : null;
        if (targetLabel instanceof HTMLElement) {
          targetLabel.click();
        } else {
          target.click();
        }

        if (!target.checked) {
          target.checked = true;
        }

        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        changes.push({ question, answer: rule.answer, pattern: rule.pattern });
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

async function fillKnownTypeaheadQuestions(page) {
  const fields = await page.evaluate(() => {
    function normalize(text) {
      return (text || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim();
    }

    function isVisible(el) {
      if (!(el instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && el.offsetParent !== null;
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

    const candidates = Array.from(
      document.querySelectorAll("input[role='combobox'], input[aria-autocomplete='list']")
    );

    return candidates
      .filter((el) => el instanceof HTMLInputElement && isVisible(el) && el.id)
      .map((el) => ({
        id: el.id,
        question: getQuestionText(el),
        value: (el.value || "").trim(),
      }));
  });

  for (const field of fields) {
    if (!field.question) {
      continue;
    }

    const rule = COMPILED_KNOWN_ANSWERS.find((item) => item.regex.test(field.question));
    if (!rule) {
      continue;
    }

    const targetValue = normalizeText(rule.answer);
    if (normalizeText(field.value) === targetValue) {
      continue;
    }

    const input = page.locator(`#${field.id}`).first();
    const visible = await input.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    const searchValue = (rule.answer || "").split(",")[0].trim() || rule.answer;
    await input.click({ timeout: 2000 }).catch(() => {});
    await input.fill("").catch(() => {});
    await input.type(searchValue, { delay: 35 }).catch(() => {});
    await page.waitForTimeout(500);

    const answerRegex = new RegExp(escapeRegExp(rule.answer), "i");
    const searchRegex = new RegExp(escapeRegExp(searchValue), "i");
    const typeaheadContainer = page.locator(`#${field.id}-ta`).first();
    const selectedOption = await clickFirstVisibleEnabled([
      typeaheadContainer.getByRole("option", { name: answerRegex }),
      typeaheadContainer.getByRole("option", { name: searchRegex }),
      typeaheadContainer.locator(".basic-typeahead__selectable", { hasText: answerRegex }),
      typeaheadContainer.locator(".basic-typeahead__selectable", { hasText: searchRegex }),
      typeaheadContainer.locator(".search-typeahead-v2__hit", { hasText: answerRegex }),
      typeaheadContainer.locator(".search-typeahead-v2__hit", { hasText: searchRegex }),
      typeaheadContainer.locator("li", { hasText: answerRegex }),
      typeaheadContainer.locator("li", { hasText: searchRegex }),
      page.getByRole("option", { name: answerRegex }),
      page.getByRole("option", { name: searchRegex }),
    ]);

    if (!selectedOption) {
      await input.press("ArrowDown").catch(() => {});
      await input.press("Enter").catch(() => {});
    }

    await page.waitForTimeout(350);
    const current = normalizeText(await input.inputValue().catch(() => ""));
    const searchNormalized = normalizeText(searchValue);
    if (current && current.includes(searchNormalized)) {
      console.log(`Resposta automatica aplicada: "${rule.answer}".`);
      continue;
    }

    console.log(`Nao foi possivel selecionar automaticamente: "${rule.answer}".`);
    await askEnter(
      `Preencha manualmente o campo "${field.question}" com "${rule.answer}" e confirme para continuar.`
    );
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

async function closePostSubmitModalIfOpen(page) {
  await page.waitForTimeout(700);

  const modal = page.locator(".artdeco-modal, .jobs-easy-apply-modal").first();
  const modalVisible = await modal.isVisible().catch(() => false);
  if (!modalVisible) {
    return;
  }

  const closedByPrimaryButton = await clickFirstVisibleEnabled([
    page.getByRole("button", { name: /conclu[ií]do|done|fechar|close|ok/i }),
    page.locator("button:has-text('Concluído')"),
    page.locator("button:has-text('Concluido')"),
    page.locator("button:has-text('Done')"),
    page.locator("button:has-text('Fechar')"),
    page.locator("button:has-text('Close')"),
  ]);

  if (closedByPrimaryButton) {
    await page.waitForTimeout(500);
    return;
  }

  const closedByDismiss = await clickFirstVisibleEnabled([
    page.locator("button.artdeco-modal__dismiss"),
    page.locator(".artdeco-modal__dismiss"),
    page.locator("button[aria-label*='dismiss' i]"),
    page.locator("button[aria-label*='close' i]"),
    page.locator("button[aria-label*='fechar' i]"),
    page.locator("button[aria-label*='dispensa' i]"),
  ]);

  if (!closedByDismiss) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(350);

    const stillOpen = await modal.isVisible().catch(() => false);
    if (stillOpen) {
      await page.evaluate(() => {
        const btn = document.querySelector("button.artdeco-modal__dismiss, .artdeco-modal__dismiss");
        if (btn instanceof HTMLElement) {
          btn.click();
        }
      }).catch(() => {});
    }
  }

  await modal.waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(350);
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

  const startIndex = Math.min(SKIP_JOBS, total);
  if (startIndex > 0) {
    console.log(`Pulando ${startIndex} vaga(s) antes de iniciar os envios.`);
  }

  for (let i = startIndex; i < total && applied < MAX_APPS; i++) {
    await closePostSubmitModalIfOpen(page);
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
    await fillKnownTypeaheadQuestions(page);

    let steps = 0;
    let submitted = false;
    while (steps < 7) {
      await fillKnownQuestions(page);
      await fillKnownTypeaheadQuestions(page);

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
      await askEnter(
        `Preencha manualmente a vaga ${i + 1} no modal atual. Quando terminar, confirme para continuar o processamento.`
      );
      await closeModalIfOpen(page);
    } else {
      await closePostSubmitModalIfOpen(page);
    }

    await page.waitForTimeout(1000);
  }

  await context.storageState({ path: STORAGE });
  console.log(`Finalizado. Total enviado: ${applied}`);
})();
