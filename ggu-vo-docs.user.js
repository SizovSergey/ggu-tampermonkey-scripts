// ==UserScript==
// @name         ГГУ — Документы абитуриента (Заявление + Согласие ПД + Титульный лист)
// @namespace    http://tampermonkey.net/
// @version      6.18
// @description  Формирует заявление о приёме (по XSLT-шаблону ГГУ), согласие на обработку ПД и титульный лист личного дела
// @match        *://*/vo/admission/entrants/*/profile*
// @updateURL    https://raw.githubusercontent.com/SizovSergey/ggu-tampermonkey-scripts/main/ggu-vo-docs.user.js
// @downloadURL  https://raw.githubusercontent.com/SizovSergey/ggu-tampermonkey-scripts/main/ggu-vo-docs.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // =====================================================================
    // УТИЛИТЫ
    // =====================================================================

    const $ = (sel, root = document) => (root || document).querySelector(sel);
    const $$ = (sel, root = document) => Array.from((root || document).querySelectorAll(sel));

    function txt(el, def = '') {
        return el ? el.textContent.trim().replace(/\s+/g, ' ') : def;
    }

    function cleanPlaceholder(value) {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        return /^[-–—]+$/.test(text) ? '' : text;
    }

    function normalizedText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function manualStorageKey(profile = {}) {
        const id = profile.studentId || profile.fullName || location.pathname;
        return `ggu-vo-docs-manual:${id}`;
    }

    function loadManual(profile) {
        try {
            return JSON.parse(localStorage.getItem(manualStorageKey(profile)) || '{}');
        } catch {
            return {};
        }
    }

    function saveManual(profile, patch) {
        const current = loadManual(profile);
        const merged = {
            ...current,
            ...patch,
            updatedAt: new Date().toISOString(),
        };
        localStorage.setItem(manualStorageKey(profile), JSON.stringify(merged));
        return merged;
    }

    function profileWithManual(profile, manual = {}) {
        const regAddress = cleanPlaceholder(manual.regAddress) || cleanPlaceholder(profile.regAddress);
        const factAddress = cleanPlaceholder(manual.factAddress) || cleanPlaceholder(profile.factAddress) || regAddress;
        return { ...profile, regAddress, factAddress };
    }

    // Найти ближайший к лейблу элемент-значение (для блоков "Лейбл / значение")
    function valueByLabel(labelText, root = document) {
        const labels = $$('.leading-6', root);
        const needle = normalizedText(labelText);
        for (const lab of labels) {
            if (normalizedText(lab.textContent).includes(needle)) {
                let sib = lab.nextElementSibling;
                if (!sib) continue;
                // иногда значение лежит во вложенном div'е
                const innerP = sib.querySelector('p, span');
                return txt(innerP || sib);
            }
        }
        return '';
    }

    function sectionHeaderControl(section) {
        if (!section) return null;
        return section.querySelector(':scope > button, :scope > [role="button"]')
            || (section.firstElementChild?.matches?.('button, [role="button"]') ? section.firstElementChild : null);
    }

    function sectionHeaderText(section) {
        const header = sectionHeaderControl(section);
        return txt(header);
    }

    function sectionContentElement(section) {
        const header = sectionHeaderControl(section);
        return Array.from(section?.children || []).find(child => child !== header && child.tagName === 'DIV') || null;
    }

    // Найти секцию по заголовку аккордеона.
    function sectionByTitle(title) {
        const sections = $$('section.group\\/disclosure, section[class*="group/disclosure"]');
        for (const s of sections) {
            if (sectionHeaderText(s).toLowerCase().includes(title.toLowerCase())) {
                return s;
            }
        }
        return null;
    }

    // Найти под-секцию документов по типу (внутри секции "Документы")
    function documentSubSection(title) {
        const docsSec = sectionByTitle('Документы');
        if (!docsSec) return null;
        const subs = $$('section', docsSec);
        for (const s of subs) {
            if (sectionHeaderText(s).toLowerCase().includes(title.toLowerCase())) {
                return s;
            }
        }
        return null;
    }

    // Достать строки документов из под-секции (это grid-строки, а не <table>)
    function documentRowsFromSubSection(subSection) {
        if (!subSection) return [];
        // CSS-селектор с квадратными скобками внутри значения класса работает
        // нестабильно (Tailwind генерирует классы вида "grid-cols-[120px_...]").
        // Поэтому перебираем все div'ы и фильтруем по className.
        const allDivs = $$('div', subSection);
        const rows = allDivs.filter(d => {
            const c = d.className || '';
            // Это именно строка-данные: содержит grid-cols-[120px и hover:bg-primary-50
            return typeof c === 'string'
                && c.includes('grid-cols-[120px')
                && c.includes('hover:bg-primary-50');
        });
        return rows;
    }

    function parseDocumentRow(rowEl) {
        // Структура строки документа (8 колонок):
        // 0: id, 1: тип документа, 2: наименование, 3: серия, 4: номер, 5: дата выдачи, 6: статус, 7: файл
        //
        // В DOM прямые дети строки: <button> (absolute-full оверлей), <p>, <p>, <p>, <p>, <p>, <p>, <div> (статус), <div> (файл)
        // Поэтому берём прямых детей-<p> по индексам.
        const ps = $$(':scope > p', rowEl);
        return {
            id: txt(ps[0]),
            type: txt(ps[1]),
            name: txt(ps[2]),
            series: txt(ps[3]),
            number: txt(ps[4]),
            date: txt(ps[5]),
        };
    }

    function isRussianForeignPassport(doc) {
        const source = `${doc?.type || ''} ${doc?.kind || ''} ${doc?.name || ''}`.toLowerCase();
        return /(загран|загранич)/i.test(source) && /(россий|рф|russian|rf)/i.test(source);
    }

    function normalizePassportKind(kind) {
        const text = String(kind || '').trim();
        const lower = text.toLowerCase();
        if (isRussianForeignPassport({ type: text })) return text;
        if (/иностран/.test(lower)) return 'Паспорт иностранного гражданина';
        if (/паспорт/.test(lower) && /(россий|рф|rf)/i.test(text)) return 'Паспорт гражданина Российской Федерации';
        return text;
    }

    function passportPriority(doc, citizenship = '') {
        const kind = normalizePassportKind(doc?.type || doc?.kind || '');
        const lower = kind.toLowerCase();
        const isForeignCitizen = /иностран|казахстан|узбекистан|таджикистан|киргиз|кыргыз|армени|азербайджан|беларус|молдов|украин/i.test(citizenship || '');
        if (isForeignCitizen && lower.includes('иностран')) return 0;
        if (!isForeignCitizen && lower.includes('российской')) return 0;
        if (lower.includes('российской')) return 1;
        if (lower.includes('иностран')) return 1;
        if (lower.includes('паспорт')) return 2;
        return 9;
    }

    function parseRuDate(value) {
        const m = String(value || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
        if (!m) return 0;
        const time = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
        return Number.isFinite(time) ? time : 0;
    }

    function comparePassports(a, b, citizenship = '') {
        const priorityDiff = passportPriority(a, citizenship) - passportPriority(b, citizenship);
        if (priorityDiff) return priorityDiff;
        return parseRuDate(b.date) - parseRuDate(a.date);
    }

    function passportSeriesText(passport) {
        return passport?.series ? passport.series : '';
    }

    function passportConsentLine(passport) {
        const parts = [
            normalizePassportKind(passport?.kind) || 'Паспорт',
            passport?.series ? `серия ${passport.series}` : '',
            passport?.number ? `№ ${passport.number}` : '',
        ].filter(Boolean);
        return parts.join(', ');
    }

    const VO_TUITION_PRICES = {
        fullTime: {},
        partTime: {},
        mixedTime: {},
    };

    function shortFio(fullName) {
        const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return '';
        const [lastName, firstName = '', middleName = ''] = parts;
        const initials = [firstName, middleName].filter(Boolean).map(part => `${part[0]}.`).join('');
        return initials ? `${lastName} ${initials}` : lastName;
    }

    function directionCode(value) {
        return (value || '').match(/\b\d+(?:\.\d+){2,3}\b/)?.[0] || '';
    }

    function tuitionFormKey(value) {
        const text = (value || '').toLowerCase();
        if (/очно[-\s]?заоч/.test(text)) return 'mixedTime';
        if (/заоч/.test(text)) return 'partTime';
        return 'fullTime';
    }

    function formatMoney(value) {
        const n = Number(String(value || '').replace(/[^\d]/g, ''));
        return n ? new Intl.NumberFormat('ru-RU').format(n) : '';
    }

    function moneyToWordsRu(value) {
        const n = Number(String(value || '').replace(/[^\d]/g, ''));
        if (!n) return '';
        const ones = [
            ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'],
            ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'],
        ];
        const teens = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
        const tens = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
        const hundreds = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
        const plural = (num, forms) => {
            const mod100 = num % 100;
            const mod10 = num % 10;
            if (mod100 >= 11 && mod100 <= 19) return forms[2];
            if (mod10 === 1) return forms[0];
            if (mod10 >= 2 && mod10 <= 4) return forms[1];
            return forms[2];
        };
        const triad = (num, female) => {
            const parts = [];
            parts.push(hundreds[Math.floor(num / 100)]);
            const rem = num % 100;
            if (rem >= 10 && rem <= 19) {
                parts.push(teens[rem - 10]);
            } else {
                parts.push(tens[Math.floor(rem / 10)]);
                parts.push(ones[female ? 1 : 0][rem % 10]);
            }
            return parts.filter(Boolean).join(' ');
        };
        const millions = Math.floor(n / 1000000);
        const thousands = Math.floor((n % 1000000) / 1000);
        const rest = n % 1000;
        const parts = [];
        if (millions) parts.push(`${triad(millions, false)} ${plural(millions, ['миллион', 'миллиона', 'миллионов'])}`);
        if (thousands) parts.push(`${triad(thousands, true)} ${plural(thousands, ['тысяча', 'тысячи', 'тысяч'])}`);
        if (rest) parts.push(triad(rest, false));
        return `${parts.join(' ')} ${plural(n, ['рубль', 'рубля', 'рублей'])}`;
    }

    function contractYearsCeil(term) {
        const text = String(term || '').toLowerCase();
        const yearsMatch = text.match(/(\d+)\s*(?:год|года|лет)/);
        const monthsMatch = text.match(/(\d+)\s*(?:месяц|месяца|месяцев|мес)/);
        const years = yearsMatch ? Number(yearsMatch[1]) : 0;
        const months = monthsMatch ? Number(monthsMatch[1]) : 0;
        if (!years && !months) return 0;
        return years + (months > 0 ? 1 : 0);
    }

    function monthsToTerm(monthsValue) {
        const months = Number(monthsValue || 0);
        if (!months) return '';
        const years = Math.floor(months / 12);
        const rest = months % 12;
        const yearWord = years % 10 === 1 && years % 100 !== 11 ? 'год' : (years % 10 >= 2 && years % 10 <= 4 && (years % 100 < 10 || years % 100 >= 20) ? 'года' : 'лет');
        const monthWord = rest % 10 === 1 && rest % 100 !== 11 ? 'месяц' : (rest % 10 >= 2 && rest % 10 <= 4 && (rest % 100 < 10 || rest % 100 >= 20) ? 'месяца' : 'месяцев');
        return [years ? `${years} ${yearWord}` : '', rest ? `${rest} ${monthWord}` : ''].filter(Boolean).join(' ');
    }

    function contractTermForComp(comp) {
        const source = `${comp?.program || ''} ${comp?.direction || ''}`;
        const months = source.match(/(\d+)\s*мес/i)?.[1];
        return monthsToTerm(months);
    }

    function tuitionPriceForComp(comp) {
        const code = directionCode(`${comp?.direction || ''} ${comp?.program || ''}`);
        const formKey = tuitionFormKey(comp?.form || comp?.direction || '');
        return VO_TUITION_PRICES[formKey]?.[code] || '';
    }

    function contractCompKey(comp) {
        return [
            directionCode(`${comp?.direction || ''} ${comp?.program || ''}`),
            comp?.direction || '',
            comp?.program || '',
            comp?.form || '',
            comp?.placeType || '',
        ].join('|');
    }

    function passportContractLine(doc, issuedBy) {
        return [
            doc?.series ? `серия ${doc.series}` : '',
            doc?.number ? `№ ${doc.number}` : '',
            doc?.date ? `выдан ${doc.date}` : '',
            issuedBy || doc?.issuedBy || '',
        ].filter(Boolean).join(', ');
    }

    // =====================================================================
    // СБОР ДАННЫХ
    // =====================================================================

    function collectProfile() {
        // Шапка профиля — там точно есть ФИО, ДР, СНИЛС, телефон, email
        const fullName = txt($('div[title="ФИО"] span.text-lg'));
        const birthday = txt($('div[title="День рождения"] span.text-lg'));
        const snils = txt($('div[title="СНИЛС"] span.text-lg'));
        const phone = txt($('div[title="Телефон"] span.text-lg'));
        const email = txt($('div[title="Email"] span.text-lg'));

        const [lastName = '', firstName = '', middleName = ''] = fullName.split(' ');

        // Поля из карточки "Профиль"
        const profileSec = sectionByTitle('Профиль');
        const citizenship = valueByLabel('Гражданство', profileSec);
        const gender = valueByLabel('Пол', profileSec);
        const birthPlace = valueByLabel('Место рождения', profileSec);
        const regAddress = cleanPlaceholder(valueByLabel('Адрес постоянной регистрации', profileSec));
        const factAddress = cleanPlaceholder(valueByLabel('Адрес фактического проживания', profileSec)) || regAddress;

        // ID студента (из шапки)
        const idEl = $('.opacity-60.text-nowrap');
        const studentId = idEl ? idEl.textContent.replace(/[^\d]/g, '') : '';

        // Категория поступающего ("Среднее общее", "Среднее профессиональное" и т.д.)
        let category = '';
        const catEl = Array.from(document.querySelectorAll('p')).find(p =>
            p.textContent.includes('Категория поступающего:')
        );
        if (catEl) category = catEl.textContent.replace('Категория поступающего:', '').trim();

        return {
            studentId, fullName, lastName, firstName, middleName,
            birthday, snils, phone, email,
            citizenship, gender, birthPlace,
            regAddress, factAddress,
            category,
        };
    }

    function collectPassport(citizenship = '') {
        const sub = documentSubSection('Документы, удостоверяющие личность');
        if (!sub) return {};
        const rows = documentRowsFromSubSection(sub);
        if (!rows.length) return {};
        const docs = rows.map(parseDocumentRow).filter(doc => !isRussianForeignPassport(doc));
        if (!docs.length) return {};
        const data = docs
            .slice()
            .sort((a, b) => comparePassports(a, b, citizenship))[0];
        return {
            kind: normalizePassportKind(data.type),
            id: data.id,
            series: data.series,
            number: data.number,
            date: data.date,
            issuedBy: '',              // на странице нет — соберём из модалки
        };
    }

    function collectEducation() {
        // Документы об образовании могут лежать в нескольких под-секциях:
        // "Общее образование", "Среднее профессиональное образование",
        // "Высшее образование", "Документ об образовании" и т.п.
        // Соберём все под-секции внутри секции "Документы", в названии которых есть "образование".
        const docsSec = sectionByTitle('Документы');
        if (!docsSec) return [];

        const subs = $$('section', docsSec).filter(s => {
            const t = sectionHeaderText(s).toLowerCase();
            if (!t) return false;
            // НЕ "удостоверяющие личность", НЕ "индивидуальные достижения", НЕ "олимпиад"
            if (t.includes('удостовер')) return false;
            if (t.includes('достижен')) return false;
            if (t.includes('олимпиад')) return false;
            // ловим всё, что про образование
            return t.includes('образован');
        });

        const result = [];
        for (const sub of subs) {
            const subTitle = sectionHeaderText(sub);
            const rows = documentRowsFromSubSection(sub);
            for (const row of rows) {
                const d = parseDocumentRow(row);
                // Пропускаем строки без серии и номера
                if (!d.series && !d.number) continue;
                result.push({
                    section: subTitle,        // напр., "Общее образование"
                    id: d.id,
                    kind: d.type,             // напр., "Аттестат о среднем общем образовании"
                    name: d.name,             // напр., "Аттестат"
                    series: d.series,
                    number: d.number,
                    date: d.date,
                    issuedBy: '',
                });
            }
        }
        return result.sort((a, b) => parseRuDate(b.date) - parseRuDate(a.date));
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function waitForElement(selector, timeoutMs = 2500) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const el = document.querySelector(selector);
            if (el) return el;
            await sleep(80);
        }
        return null;
    }

    function modalValueByLabel(modal, label) {
        const labelEl = Array.from(modal.querySelectorAll('div'))
            .find(el => txt(el) === label);
        if (!labelEl) return '';
        const container = labelEl.parentElement;
        const valueEl = container?.querySelector(':scope > p, :scope > span, :scope > div:not(.leading-6)');
        return txt(valueEl);
    }

    function documentRowById(id) {
        if (!id) return null;
        const docsSec = sectionByTitle('Документы');
        const rows = docsSec
            ? $$('div', docsSec).filter(d => {
                const c = d.className || '';
                return typeof c === 'string'
                    && c.includes('grid-cols-[120px')
                    && c.includes('hover:bg-primary-50');
            })
            : [];
        return rows.find(row => txt($(':scope > p', row)) === String(id)) || null;
    }

    async function readDocumentModalIssuedBy(doc) {
        const row = documentRowById(doc?.id);
        const button = row?.querySelector(':scope > button.absolute-full, :scope > button');
        if (!button) return '';
        button.click();
        const modal = await waitForElement('.ant-modal-root .ant-modal[role="dialog"], .ant-modal-root [role="dialog"]');
        if (!modal) return '';
        await sleep(150);
        const issuedBy = modalValueByLabel(modal, 'Выдан');
        const close = modal.querySelector('.ant-modal-close, button[aria-label="Close"]');
        close?.click();
        await sleep(150);
        return issuedBy;
    }

    async function enrichDocumentIssuers(data) {
        try {
            if (data.passport?.id && !data.passport.issuedBy) {
                data.passport.issuedBy = await readDocumentModalIssuedBy(data.passport);
            }
            const education = data.education?.[0];
            if (education?.id && !education.issuedBy) {
                education.issuedBy = await readDocumentModalIssuedBy(education);
            }
        } catch (e) {
            console.warn('Не удалось автоматически прочитать поле "Выдан" из карточки документа', e);
        }
        return data;
    }

    function collectAchievementsFromSection(sec) {
        if (!sec) return [];

        const achHeaders = [];
        $$('.ant-table-thead th', sec).forEach((th, idx) => {
            if ((th.className || '').includes('border-l')) {
                const nameSpan = th.querySelector('.font-semibold');
                const name = txt(nameSpan);
                if (name) achHeaders.push({ idx, name });
            }
        });
        if (!achHeaders.length) return [];

        const scores = new Map(); // name -> score string
        $$('.ant-table-tbody tr.ant-table-row', sec).forEach(tr => {
            const tds = $$(':scope > td', tr);
            achHeaders.forEach(col => {
                if (scores.has(col.name)) return;
                const td = tds[col.idx];
                if (!td) return;
                const scoreEl = td.querySelector('p[class*="w-"]') || td.querySelector('p');
                const v = scoreEl ? txt(scoreEl).trim() : txt(td).trim();
                if (v && v !== '-' && v !== '0' && /\d/.test(v)) {
                    scores.set(col.name, v);
                }
            });
        });

        return achHeaders
            .filter(col => scores.has(col.name))
            .map(col => ({ name: col.name, score: scores.get(col.name) }));
    }

    function collectAchievements() {
        // Новая анкета держит баллы в "Общих индивидуальных достижениях",
        // а одноименный блок в "Документах" содержит только подтверждающие файлы.
        const sections = $$('section.group\\/disclosure, section[class*="group/disclosure"]');
        const candidates = sections
            .map(sec => ({ sec, title: sectionHeaderText(sec).toLowerCase() }))
            .filter(x => x.title.includes('индивидуальные достижения'))
            .sort((a, b) => Number(b.title.includes('общие')) - Number(a.title.includes('общие')));

        for (const { sec } of candidates) {
            const achievements = collectAchievementsFromSection(sec);
            if (achievements.length) return achievements;
        }
        return [];
    }

    function collectOlympiads() {
        const sub = documentSubSection('Документы, подтверждающие участие в олимпиаде');
        if (!sub) return [];
        const rows = documentRowsFromSubSection(sub);
        return rows.map(parseDocumentRow);
    }

    function collectBenefits() {
        const sec = sectionByTitle('Особые права');
        if (!sec) return [];
        if (sec.querySelector('.ant-empty')) return [];

        // Читаем заголовки benefit-колонок (class содержит "border-l")
        // Каждый такой th содержит: span.font-semibold (тип квоты) + span с серым текстом (название документа)
        const benefitHeaders = [];
        $$('.ant-table-thead th', sec).forEach((th, idx) => {
            if ((th.className || '').includes('border-l')) {
                const quotaSpan = th.querySelector('.font-semibold');
                const docSpan   = th.querySelector('.text-gray-400, [class*="text-gray"]');
                benefitHeaders.push({
                    idx,
                    quotaType: txt(quotaSpan),
                    docName:   txt(docSpan),
                });
            }
        });

        const result = [];
        $$('.ant-table-tbody tr.ant-table-row', sec).forEach(tr => {
            const tds = $$(':scope > td', tr);

            // Тип квоты берём из ячейки с классом "before:hidden"
            const quotaTd   = tds.find(td => (td.className || '').includes('before:hidden'));
            const quotaType = quotaTd ? txt(quotaTd) : '';

            if (benefitHeaders.length) {
                benefitHeaders.forEach(col => {
                    const td = tds[col.idx];
                    if (!td) return;
                    // Подтверждено, если есть элемент .text-success или текст содержит "да/учтено"
                    const confirmed = td.querySelector('.text-success') || /да|учтено/i.test(txt(td));
                    if (confirmed) {
                        result.push({
                            name:      col.docName  || col.quotaType || quotaType || 'Льгота',
                            quotaType: col.quotaType || quotaType,
                        });
                    }
                });
            } else if (quotaType) {
                // Запасной вариант — нет явных benefit-колонок
                result.push({ name: quotaType, quotaType });
            }
        });

        // Убираем дубли
        const seen = new Set();
        return result.filter(b => {
            const key = b.name + '|' + b.quotaType;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function collectEntranceExams() {
        const sec = sectionByTitle('Вступительные испытания');
        if (!sec) return { enrollments: [], egeResults: [] };

        const rows = $$('.ant-table-tbody tr.ant-table-row', sec);
        const enrollments = [];
        const egeResults = [];
        const seenEnrollments = new Set();

        const cellDateTime = (cell) => {
            if (!cell) return '';
            const preferred = txt(cell.querySelector('p.text-secondary')).trim();
            if (/\d{2}\.\d{2}\.\d{4}/.test(preferred)) return preferred;
            const raw = txt(cell).trim();
            const m = raw.match(/\d{2}\.\d{2}\.\d{4}(?:\s+\d{2}:\d{2})?/);
            return m ? m[0] : '';
        };

        const scoreFromCell = (cell) => {
            if (!cell) return '';
            const scoreDiv = $$('div', cell).find(d => {
                const c = d.className || '';
                return c.includes('flex-col') && c.includes('items-center');
            });
            const raw = scoreDiv ? txt(scoreDiv.querySelector('p')).trim() : txt(cell).trim();
            return raw && /^\d+([.,]\d+)?$/.test(raw) ? raw : '';
        };

        const pushEnrollment = (item) => {
            const key = [item.subject, item.typeInfo, item.datetime].join('|');
            if (seenEnrollments.has(key)) return;
            seenEnrollments.add(key);
            enrollments.push(item);
        };

        rows.forEach(tr => {
            const tds = $$(':scope > td.ant-table-cell', tr);
            if (tds.length < 4) return;

            const subject = txt(tds[0].querySelector('p') || tds[0]);

            const typeEl = tds[1].querySelector('.space-y-1');
            const typeInfo = typeEl
                ? typeEl.textContent.replace(/\s+/g, ' ').trim()
                : txt(tds[1]);

            const datetime = cellDateTime(tds[2]);
            const vviScore = scoreFromCell(tds[4]);
            if (subject && datetime) {
                pushEnrollment({ subject, typeInfo, datetime, vviScore });
            }

            // Результат ЕГЭ — первый <p> внутри div с классами flex-col и items-center
            const score = scoreFromCell(tds[3]);
            if (score && /^\d+$/.test(score)) {
                egeResults.push({ subject, score });
            }
        });

        return { enrollments, egeResults };
    }

    // Определить уровень образования по коду и названию направления.
    // Аспирантура использует как старые коды XX.06/07.XX, так и современные
    // коды научных специальностей вида 1.5.7, 2.1.1, 5.8.7.
    function detectLevel(directionCode, levelHint = '') {
        if (levelHint === 'postgrad') {
            return { name: 'Аспирантура', accessLevel: 'postgrad' };
        }
        const source = String(directionCode || '');
        if (/аспирантур|научн(?:ая|ой)\s+специальност/i.test(source)) {
            return { name: 'Аспирантура', accessLevel: 'postgrad' };
        }
        const m = source.match(/\d+(?:\.\d+){2,3}/);
        if (!m) return { name: '', accessLevel: '' };
        const parts = m[0].split('.');
        if (parts.length === 3 && parts[0].length === 1 && parts[1].length === 1) {
            return { name: 'Аспирантура', accessLevel: 'postgrad' };
        }
        const lvl = parts.length >= 4 ? parts[2] : parts[1];
        const map = {
            '02': { name: 'Среднее профессиональное', accessLevel: 'spo' },
            '03': { name: 'Бакалавриат', accessLevel: 'bachelor' },
            '04': { name: 'Магистратура', accessLevel: 'master' },
            '05': { name: 'Специалитет', accessLevel: 'specialist' },
            '06': { name: 'Аспирантура', accessLevel: 'postgrad' },
            '07': { name: 'Аспирантура', accessLevel: 'postgrad' },
        };
        return map[lvl] || { name: '', accessLevel: '' };
    }

    function currentEducationLevelHint() {
        const tab = new URL(location.href).searchParams.get('tab') || '';
        if (/postgraduateLevelGroup/i.test(tab)) return 'postgrad';
        const activeLevelTab = document.querySelector(
            'a[data-status="active"][href*="postgraduateLevelGroup"], a[aria-current="page"][href*="postgraduateLevelGroup"]'
        );
        if (activeLevelTab) return 'postgrad';
        return '';
    }

    function normalizeHeaderText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function competitionTableColumns(table) {
        const headers = $$(':scope > thead th, thead th', table).map(th => normalizeHeaderText(th.textContent));
        const find = (...patterns) => headers.findIndex(header => patterns.some(pattern => pattern.test(header)));
        return {
            kgId: find(/^id кг$/i),
            competitionId: find(/^id конкурса$/i),
            organization: find(/^вуз$/i),
            direction: find(/направление|научн.*специальност|специальност/),
            program: find(/образовательная.*программа|программа.*профиль/),
            form: find(/форма обучения/),
            placeType: find(/вид мест/),
            status: find(/^статус$/i),
            priority: find(/^приоритет$/i),
        };
    }

    function cellByColumn(tds, columns, name, fallbackIndex = -1) {
        const idx = columns[name] >= 0 ? columns[name] : fallbackIndex;
        return idx >= 0 ? tds[idx] : null;
    }

    function normalizeStudyForm(value) {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        if (/^очная$/i.test(text)) return 'Очная';
        if (/^заочная$/i.test(text)) return 'Заочная';
        if (/^очно[-\s]?заочная$/i.test(text)) return 'Очно-заочная';
        return '';
    }

    function isExcludedCompetitionStatus(status) {
        const text = String(status || '').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim().toLowerCase();
        return /отозван|отклонен/.test(text);
    }

    function collectApplications() {
        // Каждое заявление — это section внутри секции "Заявления"
        const appsSec = sectionByTitle('Заявления');
        if (!appsSec) return [];

        // Заявления — это под-секции вида "ЗАЯВЛЕНИЕ № 250025"
        const subSections = $$('section', appsSec).filter(s => {
            const headerText = sectionHeaderText(s);
            return /заявление/i.test(headerText) && /№/.test(headerText);
        });

        const apps = [];
        const levelHint = currentEducationLevelHint();
        for (const s of subSections) {
            const headerText = sectionHeaderText(s);
            const numMatch = headerText.match(/№\s*(\d+)/);
            const isBudget = /бюджетные/i.test(headerText);
            const isPaid = /платные/i.test(headerText);

            // Дата регистрации, источник, ЕПГУ id
            const regDate = valueByLabel('Дата регистрации', s);
            const source = valueByLabel('Источник', s);
            const epguId = valueByLabel('ЕПГУ id', s);

            // Конкурсные группы — это таблица antd
            const tableColumnCache = new WeakMap();
            const competitions = $$('.ant-table-tbody tr.ant-table-row', s).map(tr => {
                const tds = $$(':scope > td', tr);
                const rowText = txt(tr);
                const table = tr.closest('table');
                let columns = {};
                if (table) {
                    columns = tableColumnCache.get(table);
                    if (!columns) {
                        columns = competitionTableColumns(table);
                        tableColumnCache.set(table, columns);
                    }
                }

                const form = normalizeStudyForm(txt(cellByColumn(tds, columns, 'form')));

                // Fallback для старой разметки, где статус/приоритет были закрепленными колонками.
                const statusTd   = tds.find(td => {
                    const c = td.className || '';
                    return c.includes('ant-table-cell-fix-end') && c.includes('fix-end-shadow');
                });
                const priorityTd = tds.find(td => {
                    const c = td.className || '';
                    return c.includes('ant-table-cell-fix-end') && !c.includes('fix-end-shadow');
                });

                const placeTypeTd = cellByColumn(tds, columns, 'placeType');
                const placeType = placeTypeTd ? txt(placeTypeTd) : '';

                return {
                    kgId:          txt(cellByColumn(tds, columns, 'kgId', 0)),
                    competitionId: txt(cellByColumn(tds, columns, 'competitionId', 1)),
                    organization:  txt(cellByColumn(tds, columns, 'organization', 2)),
                    direction:     txt(cellByColumn(tds, columns, 'direction', 3)),
                    program:       txt(cellByColumn(tds, columns, 'program', 4)),
                    levelHint,
                    form,
                    placeType,
                    status:   txt(cellByColumn(tds, columns, 'status')) || (statusTd ? txt(statusTd) : ''),
                    priority: txt(cellByColumn(tds, columns, 'priority')) || (priorityTd ? txt(priorityTd) : ''),
                    rowText,
                };
            }).filter(c => !isExcludedCompetitionStatus(`${c.status} ${c.rowText}`))
                .map(({ rowText, ...c }) => c);

            if (!competitions.length) continue;

            apps.push({
                number: numMatch ? numMatch[1] : '',
                kind: isBudget ? 'budget' : (isPaid ? 'paid' : 'unknown'),
                regDate, source, epguId,
                competitions,
            });
        }
        return apps;
    }

    function collectAll() {
        const profile = collectProfile();
        return {
            profile,
            passport: collectPassport(profile.citizenship),
            education: collectEducation(),
            achievements: collectAchievements(),
            olympiads: collectOlympiads(),
            benefits: collectBenefits(),
            applications: collectApplications(),
            entranceExams: collectEntranceExams(),
        };
    }

    // =====================================================================
    // МОДАЛКА ДЛЯ ВВОДА НЕДОСТАЮЩИХ ДАННЫХ
    // =====================================================================

    function openModal(data, onSubmit) {
        // Удаляем предыдущую модалку, если осталась
        const old = document.getElementById('ggu-doc-modal');
        if (old) old.remove();

        const profile = data.profile;
        const savedManual = loadManual(profile);
        const savedRep = savedManual.representative || {};
        const savedContract = savedManual.contract || {};
        const passportIssuedBy = savedManual.passportIssuedBy || data.passport?.issuedBy || '';
        const eduIssuer = savedManual.eduIssuer || data.education?.[0]?.issuedBy || '';
        const savedCustomerPassport = savedContract.customerPassport || {};
        const modalCustomerPassport = {
            series: savedCustomerPassport.series || data.passport?.series || '',
            number: savedCustomerPassport.number || data.passport?.number || '',
            date: savedCustomerPassport.date || data.passport?.date || '',
            issuedBy: savedCustomerPassport.issuedBy || passportIssuedBy || data.passport?.issuedBy || '',
        };
        const paidComps = (data.applications || [])
            .flatMap(app => (app.competitions || []).map(c => ({ ...c, appKind: app.kind })))
            .filter(c => c.appKind === 'paid' || /плат|договор|внебюдж/i.test(`${c.placeType || ''} ${c.status || ''}`));
        const contractComps = paidComps.length ? paidComps : [];
        const modalContractComp = contractComps.find(c => contractCompKey(c) === savedContract.compKey) || contractComps[0] || {};
        const modalContractPrice = savedContract.price || formatMoney(tuitionPriceForComp(modalContractComp));
        const modalContractTerm = savedContract.term || contractTermForComp(modalContractComp);
        const contractCompOptions = contractComps.map((comp, index) => {
            const key = contractCompKey(comp) || String(index);
            const price = tuitionPriceForComp(comp);
            const term = contractTermForComp(comp);
            const label = [
                comp.direction,
                comp.program,
                comp.form,
                comp.placeType,
                price ? `${formatMoney(price)} руб.` : 'цена не задана',
            ].filter(Boolean).join(' | ');
            return `<option value="${escapeHtml(key)}" data-price="${escapeHtml(price)}" data-term="${escapeHtml(term)}" ${key === savedContract.compKey ? 'selected' : ''}>${escapeHtml(label)}</option>`;
        }).join('');
        const isMinor = (() => {
            if (!profile.birthday) return false;
            const m = profile.birthday.match(/(\d{2})\.(\d{2})\.(\d{4})/);
            if (!m) return false;
            const bd = new Date(`${m[3]}-${m[2]}-${m[1]}`);
            const age = (Date.now() - bd.getTime()) / (365.25 * 24 * 3600 * 1000);
            return age < 18;
        })();

        const overlay = document.createElement('div');
        overlay.id = 'ggu-doc-modal';
        overlay.innerHTML = `
            <style>
                #ggu-doc-modal {
                    position: fixed; inset: 0; z-index: 99999;
                    background: rgba(0,0,0,0.45);
                    display: flex; align-items: center; justify-content: center;
                    font-family: Arial, sans-serif;
                }
                #ggu-doc-modal .modal {
                    background: #fff; border-radius: 12px;
                    max-width: 720px; width: 92%;
                    max-height: 90vh; overflow-y: auto;
                    padding: 24px;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.3);
                }
                #ggu-doc-modal h2 { margin: 0 0 16px; font-size: 18px; color: #333; }
                #ggu-doc-modal h3 { margin: 16px 0 8px; font-size: 14px; color: #636C8D; text-transform: uppercase; }
                #ggu-doc-modal .row { display: flex; gap: 12px; margin-bottom: 10px; }
                #ggu-doc-modal label { flex: 1; display: flex; flex-direction: column; font-size: 13px; color: #555; }
                #ggu-doc-modal input, #ggu-doc-modal select, #ggu-doc-modal textarea {
                    margin-top: 4px; padding: 8px 10px;
                    border: 1px solid #d9d9d9; border-radius: 6px;
                    font-size: 14px; font-family: inherit;
                }
                #ggu-doc-modal input:focus, #ggu-doc-modal select:focus {
                    outline: none; border-color: #636C8D;
                }
                #ggu-doc-modal .actions {
                    display: flex; gap: 12px; justify-content: flex-end;
                    margin-top: 20px; padding-top: 16px;
                    border-top: 1px solid #eee;
                }
                #ggu-doc-modal button {
                    padding: 10px 20px; border-radius: 8px;
                    border: none; cursor: pointer; font-size: 14px; font-weight: 600;
                }
                #ggu-doc-modal .btn-primary { background: #636C8D; color: #fff; }
                #ggu-doc-modal .btn-secondary { background: #f0f0f0; color: #333; }
                #ggu-doc-modal .hint { font-size: 12px; color: #999; margin-top: 2px; }
                #ggu-doc-modal .preset { color: #636C8D; font-size: 12px; cursor: pointer; }
                #ggu-doc-modal .checkbox-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
            </style>
            <div class="modal">
                <h2>Уточните данные для формирования заявления</h2>
                <p style="margin: 0 0 16px; font-size: 13px; color: #666;">
                    Поля, которых нет на странице профиля. Подставленные значения можно править.
                </p>

                <h3>Паспорт</h3>
                <label>Кем выдан и когда (полностью)
                    <input type="text" id="m-passport-issuedBy" value="${escapeHtml(passportIssuedBy)}" placeholder="ОУФМС России по г. Москве, 22.03.2021">
                    <span class="hint">Например: «Отделом УФМС России по гор. Москве в р-не Кузьминки, 22.03.2021»</span>
                </label>

                <h3>Профиль</h3>
                <div class="row">
                    <label>Место рождения
                        <input type="text" id="m-birthPlace" value="${escapeHtml(savedManual.birthPlace || profile.birthPlace)}">
                    </label>
                    <label>Иностранный язык
                        <select id="m-foreignLang">
                            <option value="" ${!savedManual.foreignLang ? 'selected' : ''}>не изучал/не указал</option>
                            <option ${savedManual.foreignLang === 'Английский' ? 'selected' : ''}>Английский</option>
                            <option ${savedManual.foreignLang === 'Немецкий' ? 'selected' : ''}>Немецкий</option>
                            <option ${savedManual.foreignLang === 'Французский' ? 'selected' : ''}>Французский</option>
                            <option ${savedManual.foreignLang === 'Испанский' ? 'selected' : ''}>Испанский</option>
                            <option ${savedManual.foreignLang === 'Китайский' ? 'selected' : ''}>Китайский</option>
                        </select>
                    </label>
                </div>
                <label>Адрес регистрации
                    <textarea id="m-regAddress" rows="2" placeholder="адрес по регистрации/прописке">${escapeHtml(cleanPlaceholder(savedManual.regAddress) || cleanPlaceholder(profile.regAddress))}</textarea>
                    <span class="hint">Адрес постоянной регистрации из анкеты. Если сервис подставил «-», поле будет пустым.</span>
                </label>
                <label>Адрес фактического проживания
                    <textarea id="m-factAddress" rows="2" placeholder="если совпадает с регистрацией, можно оставить таким же">${escapeHtml(cleanPlaceholder(savedManual.factAddress) || cleanPlaceholder(profile.factAddress) || cleanPlaceholder(profile.regAddress))}</textarea>
                    <span class="hint">Адрес, где абитуриент фактически проживает. Если сервис подставил «-», поле будет пустым.</span>
                </label>

                <h3>Образование</h3>
                <label>Образовательное учреждение, выдавшее документ
                    <input type="text" id="m-eduIssuer" value="${escapeHtml(eduIssuer)}" placeholder="МБОУ Гимназия № 1 г. Люберцы">
                </label>

                <h3>Договор на платное обучение</h3>
                <label>Платное направление
                    <select id="m-contract-comp">
                        ${contractCompOptions || '<option value="">Нет платных направлений</option>'}
                    </select>
                </label>
                <div class="row">
                    <label>Номер договора
                        <input type="text" id="m-contract-number" value="${escapeHtml(savedContract.number || '')}" placeholder="оставьте пустым">
                    </label>
                    <label>Стоимость за год
                        <input type="text" id="m-contract-price" value="${escapeHtml(modalContractPrice)}" placeholder="например: 150000">
                    </label>
                    <label>Срок обучения
                        <input type="text" id="m-contract-term" value="${escapeHtml(modalContractTerm)}" placeholder="например: 4 года">
                    </label>
                </div>
                <label>Заказчик
                    <input type="text" id="m-contract-customer" value="${escapeHtml(savedContract.customer || profile.fullName || '')}">
                </label>
                <div class="row">
                    <label>Серия паспорта заказчика
                        <input type="text" id="m-contract-customer-passport-series" value="${escapeHtml(modalCustomerPassport.series)}">
                    </label>
                    <label>Номер паспорта заказчика
                        <input type="text" id="m-contract-customer-passport-number" value="${escapeHtml(modalCustomerPassport.number)}">
                    </label>
                    <label>Дата выдачи
                        <input type="text" id="m-contract-customer-passport-date" value="${escapeHtml(modalCustomerPassport.date)}">
                    </label>
                </div>
                <label>Кем выдан паспорт заказчика
                    <input type="text" id="m-contract-customer-passport-issued" value="${escapeHtml(modalCustomerPassport.issuedBy)}">
                </label>
                <label>Адрес регистрации заказчика
                    <textarea id="m-contract-customer-address" rows="2">${escapeHtml(savedContract.customerAddress || cleanPlaceholder(savedManual.regAddress) || profile.regAddress || '')}</textarea>
                </label>

                <h3>Общежитие</h3>
                <div class="checkbox-row">
                    <input type="radio" id="m-hostel-no" name="hostel" value="0" ${!savedManual.needsHostel ? 'checked' : ''}>
                    <label for="m-hostel-no" style="flex-direction: row;">Не нуждаюсь</label>
                </div>
                <div class="checkbox-row">
                    <input type="radio" id="m-hostel-yes" name="hostel" value="1" ${savedManual.needsHostel ? 'checked' : ''}>
                    <label for="m-hostel-yes" style="flex-direction: row;">Нуждаюсь (с Порядком проживания ознакомлен(а))</label>
                </div>

                ${isMinor ? `
                <h3>Законный представитель (поступающий несовершеннолетний)</h3>
                <label>ФИО законного представителя
                    <input type="text" id="m-rep-name" value="${escapeHtml(savedRep.name || '')}">
                </label>
                <div class="row">
                    <label>Документ
                        <input type="text" id="m-rep-doc" value="${escapeHtml(savedRep.doc || 'Паспорт гражданина РФ')}">
                    </label>
                    <label>Серия
                        <input type="text" id="m-rep-series" value="${escapeHtml(savedRep.series || '')}">
                    </label>
                    <label>Номер
                        <input type="text" id="m-rep-number" value="${escapeHtml(savedRep.number || '')}">
                    </label>
                </div>
                <label>Кем и когда выдан
                    <input type="text" id="m-rep-issued" value="${escapeHtml(savedRep.issued || '')}">
                </label>
                ` : ''}

                <h3>Дополнительно</h3>
                <label>Регистрационный номер заявления (опционально)
                    <input type="text" id="m-regNum" value="${escapeHtml(savedManual.regNumber || '')}" placeholder="оставьте пустым для пропуска">
                </label>

                <div class="actions">
                    <button class="btn-secondary" id="m-cancel">Отмена</button>
                    <button class="btn-primary" id="m-ok">Сформировать заявление</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        $('#m-cancel', overlay).addEventListener('click', close);
        $('#m-contract-comp', overlay)?.addEventListener('change', e => {
            const selected = e.target.selectedOptions?.[0];
            const price = selected?.dataset.price || '';
            const term = selected?.dataset.term || '';
            $('#m-contract-price', overlay).value = formatMoney(price);
            $('#m-contract-term', overlay).value = term;
        });
        $('#m-ok', overlay).addEventListener('click', () => {
            const manual = {
                passportIssuedBy: $('#m-passport-issuedBy', overlay).value.trim(),
                birthPlace: $('#m-birthPlace', overlay).value.trim(),
                regAddress: cleanPlaceholder($('#m-regAddress', overlay).value),
                factAddress: cleanPlaceholder($('#m-factAddress', overlay).value),
                foreignLang: $('#m-foreignLang', overlay).value.trim(),
                eduIssuer: $('#m-eduIssuer', overlay).value.trim(),
                needsHostel: $('input[name="hostel"]:checked', overlay).value === '1',
                regNumber: $('#m-regNum', overlay).value.trim(),
                contract: {
                    compKey: $('#m-contract-comp', overlay)?.value || '',
                    number: $('#m-contract-number', overlay).value.trim(),
                    price: $('#m-contract-price', overlay).value.trim(),
                    term: $('#m-contract-term', overlay).value.trim(),
                    customer: $('#m-contract-customer', overlay).value.trim(),
                    customerPassport: {
                        series: $('#m-contract-customer-passport-series', overlay).value.trim(),
                        number: $('#m-contract-customer-passport-number', overlay).value.trim(),
                        date: $('#m-contract-customer-passport-date', overlay).value.trim(),
                        issuedBy: $('#m-contract-customer-passport-issued', overlay).value.trim(),
                    },
                    customerAddress: $('#m-contract-customer-address', overlay).value.trim(),
                },
                representative: isMinor ? {
                    name: $('#m-rep-name', overlay).value.trim(),
                    doc: $('#m-rep-doc', overlay).value.trim(),
                    series: $('#m-rep-series', overlay).value.trim(),
                    number: $('#m-rep-number', overlay).value.trim(),
                    issued: $('#m-rep-issued', overlay).value.trim(),
                } : null,
            };
            saveManual(profile, manual);
            close();
            onSubmit(manual);
        });
    }

    // =====================================================================
    // ГЕНЕРАЦИЯ ЗАЯВЛЕНИЯ (HTML по XSLT-шаблону)
    // =====================================================================

    function generateApplicationHTML(data, manual) {
        const p = profileWithManual(data.profile, manual);
        const pass = data.passport;
        const edu = data.education;
        const apps = data.applications;
        const ach = data.achievements;
        const benefits = data.benefits;
        const { enrollments, egeResults } = data.entranceExams || { enrollments: [], egeResults: [] };

        // Определяем уровень образования по первому конкурсу первого заявления
        const firstComp = apps.flatMap(app => app.competitions)[0];
        const level = firstComp ? detectLevel(firstComp.direction, firstComp.levelHint) : { name: '', accessLevel: '' };

        // Разделяем конкурсные группы на бюджетные и платные, сортируем по приоритету
        const allCompetitions = [];
        for (const app of apps) {
            for (const c of app.competitions) {
                allCompetitions.push({ ...c, appKind: app.kind });
            }
        }

        const hasBudget = allCompetitions.some(c => c.appKind === 'budget');
        const hasPaid = allCompetitions.some(c => c.appKind === 'paid');

        const budgetComps = allCompetitions
            .filter(c => c.appKind === 'budget')
            .sort((a, b) => parseInt(a.priority || '99') - parseInt(b.priority || '99'));

        // Для магистратуры/аспирантуры не показываем колонки квот
        const isMasterOrPostgrad = budgetComps.length > 0 && budgetComps.every(c => {
            const lvl = detectLevel(c.direction, c.levelHint).accessLevel;
            return lvl === 'master' || lvl === 'postgrad';
        });
        const paidComps = allCompetitions
            .filter(c => c.appKind === 'paid')
            .sort((a, b) => parseInt(a.priority || '99') - parseInt(b.priority || '99'));

        const currentYear = new Date().getFullYear();
        const today = new Date().toLocaleDateString('ru-RU');
        const tick = '✓'; // вместо AdmGraphics/tick.png
        const educationLevelBlock = level.name
            ? `<div style="margin:0 0 7px; font-size:11pt;"><b>Уровень образования:</b> ${escapeHtml(level.name)}</div>`
            : '';

        // ---- Шапка ----
        const headerHTML = `
            <div class="reg-num">Регистрационный № <u>${escapeHtml(manual.regNumber || '_______')} / ${escapeHtml(p.studentId)}</u></div>
            <table style="width:100%; border:none; margin: 10px 0;">
                <tr><td style="width:55%; border:none;">&nbsp;</td>
                    <td style="border:none; font-weight:bold; font-size:10pt;">
                        Ректору ФГБОУ ВО<br>
                        «Гжельский государственный университет»<br>
                        Сомову Д.С.
                    </td>
                </tr>
            </table>
        `;

        // ---- Персональные данные ----
        const personalTable = `
            <table class="t bordered">
                <tr>
                    <td width="20%"><b>Фамилия</b></td>
                    <td width="28%"><i>${escapeHtml(p.lastName)}</i></td>
                    <td colspan="4"><b>Документ, удостоверяющий личность</b></td>
                    <td width="25%"><i>${escapeHtml(normalizePassportKind(pass.kind) || '')}</i></td>
                </tr>
                <tr>
                    <td><b>Имя</b></td>
                    <td><i>${escapeHtml(p.firstName)}</i></td>
                    <td width="7%"><b>Серия</b></td>
                    <td width="13%"><i>${escapeHtml(passportSeriesText(pass))}</i></td>
                    <td width="10%"><b>Номер</b></td>
                    <td colspan="2"><i>${escapeHtml(pass.number || '')}</i></td>
                </tr>
                <tr>
                    <td><b>Отчество</b></td>
                    <td><i>${escapeHtml(p.middleName)}</i></td>
                    <td colspan="2"><b>Когда и кем выдан</b></td>
                    <td colspan="3"><i>${escapeHtml(pass.date || '')} ${escapeHtml(manual.passportIssuedBy || '')}</i></td>
                </tr>
                <tr>
                    <td><b>Дата рождения</b></td>
                    <td><i>${escapeHtml(p.birthday)}</i></td>
                    <td colspan="5" rowspan="3"><i>${escapeHtml(manual.birthPlace || '')}</i></td>
                </tr>
                <tr><td><b>Гражданство</b></td><td><i>${escapeHtml(p.citizenship)}</i></td></tr>
                <tr><td><b>СНИЛС</b></td><td><i>${escapeHtml(p.snils)}</i></td></tr>
                <tr>
                    <td><b>Адрес постоянной регистрации</b></td>
                    <td colspan="6"><i>${escapeHtml(p.regAddress)}</i></td>
                </tr>
                <tr>
                    <td><b>Адрес фактического проживания</b></td>
                    <td colspan="6"><i>${escapeHtml(p.factAddress)}</i></td>
                </tr>
                <tr>
                    <td><b>Контактный телефон</b></td>
                    <td colspan="6"><i>${escapeHtml(p.phone)}</i></td>
                </tr>
                <tr>
                    <td><b>Электронная почта</b></td>
                    <td colspan="6"><i>${escapeHtml(p.email)}</i></td>
                </tr>
            </table>
        `;

        // ---- Образование ----
        // Маппинг названия под-секции на отображаемый уровень
        const eduLevelFromSection = (sectionTitle) => {
            const t = (sectionTitle || '').toLowerCase();
            if (t.includes('основное общее')) return 'Основное общее';
            if (t.includes('общее')) return 'Среднее общее';
            if (t.includes('среднее профессиональное')) return 'Среднее профессиональное';
            if (t.includes('высшее')) return 'Высшее';
            return sectionTitle || 'Образование';
        };

        // Если массив пустой — рисуем одну пустую строку с прочерками
        const eduList = (edu && edu.length) ? edu : [{ section: '', series: '', number: '', date: '' }];

        const educationBlock = `
            <div class="text-small" style="margin-top:10px;">
                В Приёмную комиссию представлен(ы) документ(ы) об образовании:
            </div>
            <table class="t bordered" style="text-align:center; margin-top:8px;">
                <tr>
                    <td width="35%"><b>Уровень / тип документа</b></td>
                    <td width="20%"><b>Серия</b></td>
                    <td width="25%"><b>Номер</b></td>
                    <td width="20%"><b>Дата выдачи</b></td>
                </tr>
                ${eduList.map(e => `
                <tr>
                    <td style="text-align:left; padding-left:6px;">${escapeHtml(eduLevelFromSection(e.section))}${e.kind ? ` <small>(${escapeHtml(e.kind)})</small>` : ''}</td>
                    <td>${escapeHtml(e.series || '—')}</td>
                    <td>${escapeHtml(e.number || '—')}</td>
                    <td>${escapeHtml(e.date || '—')}</td>
                </tr>`).join('')}
            </table>
            <div class="text-small" style="text-align:center; border-bottom:1px solid #000; margin-top:6px;">
                Выдан ${escapeHtml(manual.eduIssuer || '__________________________________________')}
            </div>
            <div class="text-tiny" style="text-align:center;"><sub>(название образовательного учреждения)</sub></div>
        `;

        // ---- Таблица бюджетных направлений ----
        const renderBudgetRow = (c, idx) => {
            const lvlInfo = detectLevel(c.direction, c.levelHint);
            const levelName = lvlInfo.name || '—';
            return `
                <tr>
                    <td style="text-align:center;">${escapeHtml(c.priority || String(idx + 1))}</td>
                    <td style="font-size:9pt;">${escapeHtml(c.direction)}${c.program ? `<br><small>${escapeHtml(c.program)}</small>` : ''}</td>
                    <td style="text-align:center; font-size:9pt;">${escapeHtml(levelName)}</td>
                    <td style="text-align:center; font-size:9pt;">${escapeHtml(c.form || extractForm(c.direction))}</td>
                    ${!isMasterOrPostgrad ? `<td style="text-align:center;">${/отд[её]льн/i.test(c.placeType) ? tick : ''}</td>
                    <td style="text-align:center;">${/особ/i.test(c.placeType) ? tick : ''}` + '</td>' : ''}
                    <td style="text-align:center;">${/основн|общ.*конкурс|^общ/i.test(c.placeType) ? tick : ''}</td>
                    ${!isMasterOrPostgrad ? `<td style="text-align:center;">${/целев/i.test(c.placeType) ? tick : ''}</td>` : ''}
                </tr>
            `;
        };

        const budgetTable = hasBudget ? `
            <table class="t bordered">
                <tr>
                    <td rowspan="3" width="8%" style="text-align:center; vertical-align:middle;"><b>№<br>приоритета</b></td>
                    <td rowspan="3" width="32%" style="text-align:center; vertical-align:middle;"><b>Направление подготовки / специальность</b></td>
                    <td rowspan="3" width="11%" style="text-align:center; vertical-align:middle;"><b>Уровень</b></td>
                    <td rowspan="3" width="11%" style="text-align:center; vertical-align:middle;"><b>Форма обучения</b></td>
                    <td colspan="${isMasterOrPostgrad ? 1 : 4}" style="text-align:center;"><b>В рамках контрольных цифр приёма:</b></td>
                </tr>
                <tr>
                    <td colspan="${isMasterOrPostgrad ? 1 : 4}" style="text-align:center;"><b>В рамках КЦП</b></td>
                </tr>
                <tr>
                    ${!isMasterOrPostgrad ? '<td style="text-align:center; font-size:8pt;">Отд.квота</td><td style="text-align:center; font-size:8pt;">в пределах особой квоты</td>' : ''}
                    <td style="text-align:center; font-size:8pt;">основные места / общий конкурс</td>
                    ${!isMasterOrPostgrad ? '<td style="text-align:center; font-size:8pt;">целевая квота</td>' : ''}
                </tr>
                ${budgetComps.map(renderBudgetRow).join('')}
            </table>
        ` : '';

        // ---- Таблица платных направлений ----
        const renderPaidRow = (c, idx) => {
            const lvlInfo = detectLevel(c.direction, c.levelHint);
            const levelName = lvlInfo.name || '—';
            return `
                <tr>
                    <td style="text-align:center;">${escapeHtml(c.priority || String(idx + 1))}</td>
                    <td style="font-size:9pt;">${escapeHtml(c.direction)}${c.program ? `<br><small>${escapeHtml(c.program)}</small>` : ''}</td>
                    <td style="text-align:center; font-size:9pt;">${escapeHtml(levelName)}</td>
                    <td style="text-align:center; font-size:9pt;">${escapeHtml(c.form || extractForm(c.direction))}</td>
                    <td style="text-align:center;">${tick}</td>
                </tr>
            `;
        };

        const paidTable = hasPaid ? `
            <table class="t bordered" style="margin-top:8px;">
                <tr>
                    <td width="8%" style="text-align:center; vertical-align:middle;"><b>№<br>приоритета</b></td>
                    <td width="35%" style="text-align:center; vertical-align:middle;"><b>Направление подготовки / специальность</b></td>
                    <td width="12%" style="text-align:center; vertical-align:middle;"><b>Уровень</b></td>
                    <td width="12%" style="text-align:center; vertical-align:middle;"><b>Форма обучения</b></td>
                    <td style="text-align:center; vertical-align:middle;"><b>По договору об оказании платных образовательных услуг</b></td>
                </tr>
                ${paidComps.map(renderPaidRow).join('')}
            </table>
        ` : '';

        // ---- Результаты ЕГЭ ----
        const egeBlock = egeResults.length ? `
            <div style="margin-top:10px;"><b>1.&nbsp;&nbsp;Прошу зачислить в качестве результатов вступительных испытаний следующие результаты ЕГЭ/ЦТ РБ</b></div>
            <table class="t bordered">
                <tr style="text-align:center;">
                    <td width="5%"><b>№</b></td>
                    <td width="40%"><b>Наименование предмета</b></td>
                    <td width="15%"><b>Результат (балл)</b></td>
                </tr>
                ${egeResults.map((r, i) => `
                <tr>
                    <td style="text-align:center;">${i + 1}</td>
                    <td>${escapeHtml(r.subject)}</td>
                    <td style="text-align:center;">${escapeHtml(r.score)}</td>
                </tr>`).join('')}
            </table>
        ` : '';

        // ---- Запись на вступительные испытания ----
        const viEnrollNum = egeResults.length ? 2 : 1;
        const viBlock = enrollments.length ? `
            <div style="margin-top:10px;"><b>${viEnrollNum}.&nbsp;&nbsp;Прошу допустить к сдаче вступительных испытаний в ГГУ по следующим предметам:</b></div>
            <table class="t bordered">
                <tr style="text-align:center;">
                    <td width="5%"><b>№</b></td>
                    <td width="30%"><b>Наименование предмета</b></td>
                    <td width="40%"><b>Тип ВИ</b></td>
                    <td width="25%"><b>Дата и время</b></td>
                </tr>
                ${enrollments.map((r, i) => `
                <tr>
                    <td style="text-align:center;">${i + 1}</td>
                    <td>${escapeHtml(r.subject)}</td>
                    <td>Внутреннее вступительное испытание</td>
                    <td style="text-align:center;">${escapeHtml(r.datetime)}</td>
                </tr>`).join('')}
            </table>
        ` : '';

        // Динамическая нумерация следующих разделов
        const prevSections = (egeResults.length ? 1 : 0) + (enrollments.length ? 1 : 0);
        const benefitsNum = prevSections + 1;
        const achNum = prevSections + (hasBudget && benefits.length ? 2 : 1);

        // ---- Льготы ----
        const benefitsBlock = hasBudget && benefits.length ? `
            <div style="margin-top:10px;"><b>${benefitsNum}.&nbsp;&nbsp;Право на обучение за счёт бюджетных ассигнований</b>
                <small>(копии документов прилагаются к заявлению)</small>
            </div>
            <table class="t bordered">
                <tr style="text-align:center;">
                    <td width="55%"><b>Право на льготы</b></td>
                    <td width="10%"><b>Имею</b></td>
                    <td width="35%"><b>Тип льготы</b></td>
                </tr>
                ${benefits.map(b => `
                <tr>
                    <td>${escapeHtml(b.name)}</td>
                    <td style="text-align:center;">${tick}</td>
                    <td style="text-align:center;">${escapeHtml(b.quotaType)}</td>
                </tr>`).join('')}
            </table>
        ` : '';

        // ---- Индивидуальные достижения ----
        const achBlock = ach.length ? `
            <div style="margin-top:10px;"><b>${achNum}. Индивидуальные достижения</b>
                <small>(копии документов прилагаются к заявлению)</small>
            </div>
            <table class="t bordered">
                <tr style="text-align:center;">
                    <td width="5%"><b>№</b></td>
                    <td width="75%"><b>Наименование достижения</b></td>
                    <td width="20%"><b>Количество баллов</b></td>
                </tr>
                ${ach.map((a, i) => `
                <tr>
                    <td style="text-align:center;">${i + 1}</td>
                    <td>${escapeHtml(a.name)}</td>
                    <td style="text-align:center;">${escapeHtml(a.score || '')}</td>
                </tr>`).join('')}
            </table>
        ` : '';

        // ---- Общежитие ----
        const hostelBlock = `
            <div style="margin-top:10px;">
                В общежитии&nbsp;&nbsp;
                ${!manual.needsHostel ? `${tick} не нуждаюсь` : `${tick} нуждаюсь&nbsp;&nbsp;${tick} с Порядком проживания ознакомлен(а)`}
            </div>
        `;

        // ---- Блок ознакомления ----
        const acknowledgeBlock = `
            <table class="t dashed" style="margin-top:10px;">
                <tr>
                    <td><div><b>Ознакомлен(а)</b> (в том числе через информационные системы общего пользования) с:</div></td>
                    <td width="15%" style="text-align:center;"><div><b>Подтверждаю</b></div></td>
                </tr>
                <tr><td>— копиями устава и лицензии на осуществление образовательной деятельности (с приложениями)</td><td style="text-align:center; font-size:14pt;">${tick}</td></tr>
                <tr><td>— копией свидетельства о государственной аккредитации (с приложениями)</td><td style="text-align:center; font-size:14pt;">${tick}</td></tr>
                <tr><td>— Правилами приёма в ГГУ в ${currentYear} году</td><td style="text-align:center; font-size:14pt;">${tick}</td></tr>
                <tr><td>— информацией о предоставляемых особых правах и преимуществах при приёме на обучение</td><td style="text-align:center; font-size:14pt;">${tick}</td></tr>
                <tr><td>— датой завершения приёма заявлений о согласии на зачисление</td><td style="text-align:center; font-size:14pt;">${tick}</td></tr>
                ${hasPaid ? `<tr><td>— датой заключения договора об образовании</td><td style="text-align:center; font-size:14pt;">${tick}</td></tr>` : ''}
                <tr><td>— правилами подачи апелляции при проведении вступительных испытаний</td><td style="text-align:center; font-size:14pt;">${tick}</td></tr>
                <tr><td><b>Подтверждаю:</b> достоверность сведений в заявлении о себе</td><td style="text-align:center; font-size:14pt;">${tick}</td></tr>
                <tr><td>— подачу заявления не более чем в пять вузов (учитывая заявление в ГГУ)</td><td style="text-align:center; font-size:14pt;">${tick}</td></tr>
                <tr><td>— отсутствие у поступающего диплома бакалавра, специалиста, магистра (для бакалавриата/специалитета)</td><td style="text-align:center; font-size:14pt;">${tick}</td></tr>
                <tr><td><b>Обязуюсь:</b> при необходимости предоставить свидетельство о признании иностранного образования</td><td style="text-align:center; font-size:14pt;">${tick}</td></tr>
            </table>
        `;

        // ---- Иностранный язык ----
        const langBlock = `
            <div style="margin-top:10px;">
                <b>Иностранный язык:</b>&nbsp;&nbsp;
                ${manual.foreignLang ? `${tick} ${escapeHtml(manual.foreignLang)}` : 'не изучал / не указал'}
            </div>
        `;

        // ---- Представитель (если несовершеннолетний) ----
        const repBlock = manual.representative && manual.representative.name ? `
            <div style="margin-top:10px; padding:8px; border:1px solid #999;">
                <b>Законный представитель:</b><br>
                ФИО: ${escapeHtml(manual.representative.name)}<br>
                ${escapeHtml(manual.representative.doc)}, серия ${escapeHtml(manual.representative.series)},
                № ${escapeHtml(manual.representative.number)}, выдан ${escapeHtml(manual.representative.issued)}
            </div>
        ` : '';

        // ---- Финальный HTML ----
        const html = `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="UTF-8">
<title>Заявление № ${escapeHtml(manual.regNumber || p.studentId)}</title>
<style>
@page { size: A4; margin: 12mm; }
body {
    width: 180mm; margin: 10px auto;
    font-family: Arial, sans-serif; font-size: 11pt;
    color: #000; background: #fff;
}
.reg-num { font-size: 10pt; font-weight: bold; }
.t { width: 100%; border-collapse: collapse; }
.t.bordered td, .t.bordered th { border: 1px solid #000; padding: 4px 6px; vertical-align: middle; }
.t.dashed td { border: 1px dashed #555; padding: 4px 6px; }
.text-small { font-size: 10pt; }
.text-tiny { font-size: 8pt; color: #555; }
.hint { font-size: 8pt; color: #c80; }
h1.title {
    text-align: center; font-size: 13pt; font-weight: bold;
    margin: 14px 0 8px;
}
.intro { font-size: 11pt; font-weight: bold; margin-bottom: 6px; }
.signature { margin-top: 16px; font-size: 11pt; }
.no-print { margin: 18px auto; display: flex; gap: 12px; justify-content: center; }
.no-print button {
    padding: 10px 24px; font-size: 14px; cursor: pointer;
    background: #636C8D; color: #fff; border: none; border-radius: 6px;
}
.no-print button.secondary { background: #999; }
@media print { .no-print { display: none; } body { width: 100%; margin: 0; } }
</style>
</head>
<body>

${headerHTML}
${personalTable}
${educationBlock}

<h1 class="title">ЗАЯВЛЕНИЕ</h1>
<div class="intro">Прошу допустить меня к участию в конкурсе на 1 курс по следующим условиям приёма и основаниям приёма:</div>
${educationLevelBlock}

${hasBudget ? `<div style="margin-bottom:4px; font-size:10pt; font-weight:bold;">Бюджетные места в рамках КЦП:</div>` : ''}
${budgetTable}

${hasPaid ? `<div style="margin-top:10px; margin-bottom:4px; font-size:10pt; font-weight:bold;">По договорам об оказании платных образовательных услуг:</div>` : ''}
${paidTable}

${egeBlock}
${viBlock}
${benefitsBlock}
${achBlock}
${hostelBlock}
${acknowledgeBlock}

<div style="margin-top:10px;" class="text-small">
В случае непоступления на обучение в ГГУ прошу вернуть мне оригиналы поданных документов
(если такие предоставлялись) следующим способом: <u><b>лично</b></u>.
</div>

${langBlock}

<div class="signature">
«______» __________ ${currentYear} г.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
Подпись _________________
</div>

<div style="text-align:right; margin-top:14px;" class="text-small">
______________________________________ / ФИО сотрудника приёмной комиссии
</div>

<div class="no-print">
    <button onclick="window.print()">🖨️ Распечатать</button>
    <button class="secondary" onclick="window.close()">✖️ Закрыть</button>
</div>

</body></html>`;

        return html;
    }

    // Извлечь форму обучения из строки "6.44.03.02 - Очная"
    function extractForm(directionStr) {
        const m = (directionStr || '').match(/-\s*(Очная|Очно-заочная|Заочная)/i);
        return m ? normalizeStudyForm(m[1]) : '';
    }

    // =====================================================================
    // ГЕНЕРАЦИЯ СОГЛАСИЯ ПД и ТИТУЛЬНОГО ЛИСТА (без изменений по сути,
    // только используют новый формат данных)
    // =====================================================================

    function generateConsentHTML(data, manual) {
        const p = profileWithManual(data.profile, manual);
        const pass = data.passport;
        const currentYear = new Date().getFullYear();
        const rep = manual.representative;

        // Блок данных субъекта (поступающего)
        const subjectRow = `
            <tr><td class="lab">Фамилия, имя, отчество</td><td class="val">${escapeHtml(p.fullName)}</td></tr>
            <tr><td class="lab">Дата рождения</td><td class="val">${escapeHtml(p.birthday)}</td></tr>
            <tr><td class="lab">Место рождения</td><td class="val">${escapeHtml(manual.birthPlace || '')}</td></tr>
            <tr><td class="lab">Адрес регистрации</td><td class="val">${escapeHtml(p.regAddress)}</td></tr>
            <tr><td class="lab">Документ, удостоверяющий личность</td><td class="val">${escapeHtml(passportConsentLine(pass) || 'Паспорт')}</td></tr>
            <tr><td class="lab">Кем и когда выдан</td><td class="val">${escapeHtml(pass.date || '—')}, ${escapeHtml(manual.passportIssuedBy || '—')}</td></tr>
            <tr><td class="lab">СНИЛС</td><td class="val">${escapeHtml(p.snils || '—')}</td></tr>
            <tr><td class="lab">Контактный телефон</td><td class="val">${escapeHtml(p.phone || '—')}</td></tr>
            <tr><td class="lab">Электронная почта</td><td class="val">${escapeHtml(p.email || '—')}</td></tr>
        `;

        // Блок представителя (если заполнен)
        const repTable = rep && rep.name ? `
            <h3>Сведения о законном представителе</h3>
            <table class="info">
                <tr><td class="lab">ФИО законного представителя</td><td class="val">${escapeHtml(rep.name)}</td></tr>
                <tr><td class="lab">Документ, удостоверяющий личность</td><td class="val">${escapeHtml(rep.doc)}, серия ${escapeHtml(rep.series)}, № ${escapeHtml(rep.number)}</td></tr>
                <tr><td class="lab">Кем и когда выдан</td><td class="val">${escapeHtml(rep.issued)}</td></tr>
            </table>
        ` : '';

        // Преамбула: «Я, ФИО, ... даю согласие»
        const preamble = rep && rep.name
            ? `<p class="intro">Я, <b>${escapeHtml(rep.name)}</b>, действуя как законный представитель несовершеннолетнего <b>${escapeHtml(p.fullName)}</b>, в соответствии с требованиями ст. 9 Федерального закона от 27.07.2006 № 152-ФЗ «О персональных данных» даю своё согласие федеральному государственному бюджетному образовательному учреждению высшего образования «Гжельский государственный университет» (далее — Оператор), расположенному по адресу: 140155, Московская обл., г. о. Раменский, пос. Электроизолятор, д. 67, на обработку своих персональных данных и персональных данных представляемого лица.</p>`
            : `<p class="intro">Я, <b>${escapeHtml(p.fullName)}</b>, в соответствии с требованиями ст. 9 Федерального закона от 27.07.2006 № 152-ФЗ «О персональных данных» даю своё согласие федеральному государственному бюджетному образовательному учреждению высшего образования «Гжельский государственный университет» (далее — Оператор), расположенному по адресу: 140155, Московская обл., г. о. Раменский, пос. Электроизолятор, д. 67, на обработку моих персональных данных.</p>`;

        return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">
<title>Согласие на обработку ПД</title>
<style>
@page { size: A4 portrait; margin: 15mm; }
body {
    width: 180mm; margin: 10px auto;
    font-family: 'Times New Roman', serif; font-size: 12pt;
    color: #000; background: #fff;
    line-height: 1.4;
}
.header {
    text-align: right;
    margin-bottom: 20px;
    font-size: 11pt;
}
.header .rector { width: 70mm; margin-left: auto; }
h1 {
    text-align: center;
    font-size: 14pt;
    text-transform: uppercase;
    margin: 24px 0 8px;
    font-weight: bold;
}
.subtitle {
    text-align: center;
    font-size: 11pt;
    margin-bottom: 18px;
    color: #555;
}
h3 {
    font-size: 12pt;
    margin: 16px 0 6px;
    font-weight: bold;
    border-bottom: 1px solid #999;
    padding-bottom: 2px;
}
table.info {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 8px;
    font-size: 11pt;
}
table.info td {
    border: 1px solid #000;
    padding: 4px 8px;
    vertical-align: top;
}
table.info td.lab {
    width: 38%;
    font-weight: 600;
    background: #f4f4f4;
}
p { text-align: justify; margin: 8px 0; }
p.intro { text-indent: 1cm; }
ol.body { padding-left: 20px; }
ol.body li { text-align: justify; margin: 6px 0; }
.purpose {
    margin: 8px 0;
    padding: 8px 12px;
    background: #f9f9f9;
    border-left: 3px solid #636C8D;
}
.signature-block {
    margin-top: 40px;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
}
.signature-block .date { width: 35%; }
.signature-block .sig { width: 55%; text-align: center; }
.signature-block .sig .line {
    border-bottom: 1px solid #000;
    height: 18px;
    margin-bottom: 4px;
}
.signature-block .sig .caption { font-size: 9pt; color: #555; }
.no-print { margin: 24px auto; display: flex; gap: 12px; justify-content: center; }
.no-print button {
    padding: 10px 24px; font-size: 14px; cursor: pointer;
    background: #636C8D; color: #fff; border: none; border-radius: 6px; font-family: inherit;
}
.no-print button.secondary { background: #999; }
@media print { .no-print { display: none; } body { margin: 0; } }
</style></head><body>

<div class="header">
    <div class="rector">
        Ректору ФГБОУ ВО<br>
        «Гжельский государственный университет»<br>
        Сомову Д.С.
    </div>
</div>

<h1>Согласие<br>на обработку персональных данных</h1>
<div class="subtitle">от поступающего${rep && rep.name ? ' (через законного представителя)' : ''}</div>

<h3>Сведения о субъекте персональных данных</h3>
<table class="info">
${subjectRow}
</table>

${repTable}

${preamble}

<div class="purpose"><b>Цель обработки персональных данных:</b> участие в конкурсе и зачисление в число обучающихся в ФГБОУ ВО «Гжельский государственный университет», организация образовательного процесса, обеспечение деятельности Оператора в соответствии с действующим законодательством Российской Федерации.</div>

<p><b>Перечень обрабатываемых персональных данных:</b> фамилия, имя, отчество; дата и место рождения; пол; гражданство; реквизиты документа, удостоверяющего личность; СНИЛС, ИНН; адреса регистрации и фактического проживания; контактный телефон, адрес электронной почты; сведения о составе семьи; сведения об образовании и документах об образовании; результаты вступительных испытаний и индивидуальных достижений; сведения о льготах и особых правах; фотоизображение.</p>

<p><b>Перечень действий с персональными данными:</b> сбор, систематизация, накопление, хранение, уточнение (обновление, изменение), использование, передача (предоставление, доступ, в том числе трансграничная передача), обезличивание, блокирование, удаление, уничтожение персональных данных как с использованием средств автоматизации, так и без таковых.</p>

<p>Оператор вправе передавать персональные данные третьим лицам в случаях, прямо предусмотренных законодательством Российской Федерации, в том числе федеральным органам исполнительной власти, осуществляющим функции в сфере образования.</p>

<p>Настоящее согласие действует со дня его подписания и до достижения цели обработки персональных данных или до момента отзыва в письменной форме. Согласие может быть отозвано путём направления письменного заявления в адрес Оператора.</p>

<p>Я подтверждаю, что ознакомлен(а) с правами субъекта персональных данных, предусмотренными Федеральным законом от 27.07.2006 № 152-ФЗ «О персональных данных».</p>

<div class="signature-block">
    <div class="date">
        «______» ________________ ${currentYear} г.
    </div>
    <div class="sig">
        <div class="line"></div>
        <div class="caption">(подпись)</div>
    </div>
</div>

<div class="no-print">
    <button onclick="window.print()">🖨️ Распечатать</button>
    <button class="secondary" onclick="window.close()">✖️ Закрыть</button>
</div>

</body></html>`;
    }

    function generateTitlePageHTML(data, manual) {
        const p = data.profile;
        const currentYear = new Date().getFullYear();
        const lang = manual.foreignLang || 'не указан';

        // Собираем все конкурсные группы: бюджет первым, затем платные, внутри — по приоритету
        const allComps = [];
        for (const app of data.applications) {
            for (const c of app.competitions) {
                allComps.push({ ...c, appKind: app.kind });
            }
        }
        allComps.sort((a, b) => {
            if (a.appKind !== b.appKind) return a.appKind === 'budget' ? -1 : 1;
            return parseInt(a.priority || '99') - parseInt(b.priority || '99');
        });

        // Группируем по направлению: одно направление — одна строка, профили через «/»
        const dirMap = new Map();
        for (const c of allComps) {
            if (!dirMap.has(c.direction)) {
                dirMap.set(c.direction, { direction: c.direction, programs: [], placeTypes: [], forms: [] });
            }
            const entry = dirMap.get(c.direction);
            if (c.program && !entry.programs.includes(c.program)) {
                entry.programs.push(c.program);
            }
            let typeLabel = '';
            if (c.appKind === 'paid') {
                typeLabel = 'По договору';
            } else if (/отд[её]льн/i.test(c.placeType)) {
                typeLabel = 'Отдельная квота';
            } else if (/особ/i.test(c.placeType)) {
                typeLabel = 'Особая квота';
            } else if (/целев/i.test(c.placeType)) {
                typeLabel = 'Целевая квота';
            } else if (/основн|общ/i.test(c.placeType)) {
                typeLabel = 'Основные места (КЦП)';
            } else if (c.appKind === 'budget') {
                typeLabel = 'Бюджет';
            }
            if (typeLabel && !entry.placeTypes.includes(typeLabel)) {
                entry.placeTypes.push(typeLabel);
            }
            // Форма обучения: берём из колонки, с фолбэком на парсинг строки
            const cForm = c.form || extractForm(c.direction);
            if (cForm && !entry.forms.includes(cForm)) entry.forms.push(cForm);
        }
        const uniqueDirs = Array.from(dirMap.values());

        const firstComp = allComps[0] || null;
        const level = firstComp ? detectLevel(firstComp.direction, firstComp.levelHint) : { name: '' };
        const form = firstComp ? (firstComp.form || extractForm(firstComp.direction)) : '';

        const hasBudget = allComps.some(c => c.appKind === 'budget');
        const hasPaid   = allComps.some(c => c.appKind === 'paid');
        const fundingDisplay = hasBudget && hasPaid ? 'Бюджет / Внебюджет'
            : hasBudget ? 'Бюджет' : hasPaid ? 'Внебюджет' : '—';

        // Размер шрифта: немного крупнее, адаптируется при большом количестве направлений
        const dirFontSize  = uniqueDirs.length > 4 ? '9pt'   : '10pt';
        const progFontSize = uniqueDirs.length > 4 ? '8pt'   : '9pt';
        const typeFontSize = uniqueDirs.length > 4 ? '7.5pt' : '8.5pt';

        const directionsHTML = uniqueDirs.map((d, i) => {
            const prefix = uniqueDirs.length > 1 ? `${i + 1}.\u00a0` : '';
            const typeStr = d.placeTypes.length
                ? `<span style="font-size:${typeFontSize}; color:#333;"> \u2014 ${d.placeTypes.map(escapeHtml).join(', ')}</span>`
                : '';
            const formStr = d.forms.length
                ? `<span style="font-size:${typeFontSize}; color:#555;"> (${d.forms.map(escapeHtml).join(', ')})</span>`
                : '';
            const progs = d.programs.length
                ? `<br><i style="font-size:${progFontSize}; padding-left:12px;">${d.programs.map(escapeHtml).join(' / ')}</i>`
                : '';
            return `<p style="margin:3px 0; font-size:${dirFontSize}; text-align:left;">${prefix}<b>${escapeHtml(d.direction)}</b>${formStr}${typeStr}${progs}</p>`;
        }).join('');

        return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Личное дело № ${escapeHtml(p.studentId)}</title>
<style>
@page { size: A4; margin: 15mm; }
body { font-family: 'Times New Roman', serif; width: 180mm; margin: 0 auto; }
.main { border: 1px solid #000; padding: 20px; text-align: center; min-height: 250mm; display: flex; flex-direction: column; }
.main p { margin: 2px 0; }
.right { text-align: right; padding-right: 40px; }
.name { text-transform: uppercase; text-decoration: underline; font-size: 28pt; font-weight: bold; margin: 4px auto; }
.padding { padding-top: 50px; }
.footer { margin-top: auto; padding-top: 30px; }
.no-print { margin: 18px auto; display: flex; gap: 12px; justify-content: center; }
.no-print button { padding: 10px 24px; font-size: 14px; cursor: pointer;
    background: #636C8D; color: #fff; border: none; border-radius: 6px; }
@media print { .no-print { display: none; } }
</style></head><body>

<div class="main">
    <p>МИНОБРНАУКИ РОССИИ</p>
    <p>Федеральное государственное бюджетное образовательное учреждение высшего образования</p>
    <p><b>«Гжельский государственный университет»</b></p>
    <p>(ГГУ)</p>
    ${form ? `<p>(${escapeHtml(form.toLowerCase())} форма обучения)</p>` : ''}

    <div class="right">
        <p>${escapeHtml(fundingDisplay)}</p>
        <p><u>${escapeHtml(lang)}</u> язык</p>
    </div>

    <p class="padding"><b>ЛИЧНОЕ ДЕЛО № ${escapeHtml(p.studentId)}</b></p>
    <p class="name">${escapeHtml(p.lastName)}</p>
    <p class="name">${escapeHtml(p.firstName)}</p>
    <p class="name">${escapeHtml(p.middleName)}</p>

    <div style="margin-top:20px; text-align:left;">
        <p style="text-align:center; margin-bottom:4px;">${escapeHtml(level.name)}</p>
        <p style="font-size:9pt; margin-bottom:2px; text-align:center;">Направление${uniqueDirs.length > 1 ? 'я' : ''} подготовки / специальность${uniqueDirs.length > 1 ? 'и' : ''}:</p>
        ${directionsHTML}
    </div>

    <div class="footer">
        <p>Год поступления — ${currentYear}</p>
        <p>пос. Электроизолятор</p>
    </div>
</div>

<div class="no-print">
    <button onclick="window.print()">🖨️ Распечатать</button>
    <button onclick="window.close()" style="background:#999;">✖️ Закрыть</button>
</div>

</body></html>`;
    }

    function generateExamSheetHTML(data, sheetNum) {
        const p = data.profile;
        const { enrollments } = data.entranceExams || { enrollments: [] };

        const allComps = [];
        for (const app of data.applications) {
            for (const c of app.competitions) allComps.push({ ...c, appKind: app.kind });
        }
        allComps.sort((a, b) => {
            if (a.appKind !== b.appKind) return a.appKind === 'budget' ? -1 : 1;
            return parseInt(a.priority || '99') - parseInt(b.priority || '99');
        });
        const firstComp = allComps[0] || null;
        const form = firstComp ? (firstComp.form || extractForm(firstComp.direction)) : '';

        const headerHTML = `
            <table border="0" width="100%" cellspacing="0" cellpadding="2"
                   style="border-bottom:3px double #333;">
                <tr><td align="center">
                    <font size="4"><b>ФГБОУ ВО «Гжельский государственный университет»</b></font>
                </td></tr>
            </table>
            <table border="0" width="100%" cellspacing="0" cellpadding="2" style="font-size:12px;">
                <tr><td align="center">
                    РОССИЯ, 140155, г.&nbsp;Электроизолятор, д.&nbsp;67, тел.&nbsp;+7&nbsp;(496)&nbsp;464-76-40
                </td></tr>
            </table>`;

        const studentRows = (includeForm) => `
            <tr valign="bottom">
                <td width="27%">Фамилия:</td>
                <td width="73%"><span style="width:100%;border-bottom:1px solid;">
                    <font size="4"><b>${escapeHtml(p.lastName)}</b></font></span></td>
            </tr>
            <tr valign="bottom">
                <td>Имя:</td>
                <td><span style="width:100%;border-bottom:1px solid;">
                    <font size="4"><b>${escapeHtml(p.firstName)}</b></font></span></td>
            </tr>
            <tr valign="bottom">
                <td>Отчество:</td>
                <td><span style="width:100%;border-bottom:1px solid;">
                    <font size="4"><b>${escapeHtml(p.middleName)}</b></font></span></td>
            </tr>
            <tr>
                <td>Код:</td>
                <td><span style="width:100%;border-bottom:1px solid;">
                    <b>${escapeHtml(p.studentId)}</b></span></td>
            </tr>
            ${includeForm && form ? `
            <tr valign="top">
                <td>Форма обучения:</td>
                <td><span style="width:100%;border-bottom:1px solid;">
                    <b>${escapeHtml(form)}</b></span></td>
            </tr>` : ''}
            <tr valign="top"><td colspan="2">&nbsp;</td></tr>
            <tr valign="top">
                <td>Личная подпись:</td>
                <td><span style="width:100%;border-bottom:1px solid;">&nbsp;</span></td>
            </tr>`;

        const tableHeader = (scoreLabel) => `
            <tr>
                <th width="4%">#</th>
                <th>Дисциплина</th>
                <th width="22%">Вид испытания</th>
                <th width="14%">Дата испытания</th>
                <th width="19%">ФИО преподавателя</th>
                <th width="10%">${scoreLabel}</th>
                <th width="10%">Подпись</th>
            </tr>`;

        const sheetBlock = (title, includeForm, showScore) => `
            <table border="0" width="100%" cellpadding="0" cellspacing="0">
                <tr><td valign="top">
                    <p align="center">
                        <font size="4"><b>${escapeHtml(title)}</b></font>
                    </p>
                    <table border="0" cellpadding="2" cellspacing="3" width="100%">
                        <tr valign="top">
                            <td width="140px" align="center"
                                style="border:1px dashed #ccc;height:180px;vertical-align:middle;
                                       color:#aaa;font-size:9pt;">фото</td>
                            <td><table border="0" cellpadding="2" cellspacing="0">
                                <tbody>${studentRows(includeForm)}</tbody>
                            </table></td>
                        </tr>
                    </table>
                    <br>
                    <p align="center"><b>${showScore ? 'Результаты тестирования' : 'Оценки, полученные на вступительных испытаниях'}</b></p>
                    <table class="border">
                        <tbody>
                        ${tableHeader(showScore ? 'Оценка, баллов' : 'Оценка')}
                        ${enrollments.map((e, i) => `
                        <tr bgcolor="#ffffff" valign="top">
                            <td align="center">${i + 1}</td>
                            <td>${escapeHtml(e.subject)}</td>
                            <td>Вступительный экзамен (тест)</td>
                            <td align="center">${escapeHtml(e.datetime)}</td>
                            <td></td>
                            <td align="center">${showScore ? escapeHtml(e.vviScore || '') : ''}</td>
                            <td>&nbsp;</td>
                        </tr>`).join('')}
                        </tbody>
                    </table>
                    <br>
                    <table border="0" cellpadding="2" cellspacing="0">
                        <tr valign="top">
                            <td>Ответственный секретарь приемной комиссии:</td>
                            <td>_______________________</td>
                        </tr>
                    </table>
                </td></tr>
            </table>`;

        const numStr = sheetNum ? `<u>&nbsp;${escapeHtml(sheetNum)}&nbsp;</u>` : '<u>&nbsp;&nbsp;&nbsp;___&nbsp;&nbsp;&nbsp;</u>';

        return `<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8">
<title>Экзаменационный лист — ${escapeHtml(p.fullName)}</title>
<style>
@page { size: A4; margin: 15mm; }
body { font-family: Arial, sans-serif; font-size: 12pt; width: 180mm; margin: 0 auto; background: #fff; }
table.border { width: 100%; border-collapse: collapse; }
table.border th, table.border td { border: 1px solid #333; padding: 4px 6px; font-size: 10pt; }
.no-print { margin: 18px auto; display: flex; gap: 12px; justify-content: center; }
.no-print button { padding: 10px 24px; font-size: 14px; cursor: pointer;
    background: #636C8D; color: #fff; border: none; border-radius: 6px; }
@media print { .no-print { display: none; } body { width: 100%; margin: 0; } }
</style></head><body>

<div style="margin-bottom:20px;">
    ${headerHTML}
    <br>
    <p align="center"><font size="4"><b>Экзаменационный лист № ${numStr}</b></font></p>
    ${sheetBlock('', true, false)}
</div>

<div style="page-break-before:always; margin-bottom:20px;">
    ${headerHTML}
    <br>
    ${sheetBlock('Лист результатов тестирования', false, true)}
</div>

<div class="no-print">
    <button onclick="window.print()">🖨️ Распечатать</button>
    <button onclick="window.close()" style="background:#999;">✖️ Закрыть</button>
</div>
</body></html>`;
    }

    function generateReceiptHTML(data, manual) {
        const p = data.profile;
        const education = data.education?.[0] || {};
        const receiptDate = new Date().toLocaleDateString('ru-RU');

        return `<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8">
<title>Расписка о приёме документов — ${escapeHtml(p.fullName)}</title>
<style>
@page { size: A4 portrait; margin: 15mm; }
body { background:#fff; margin:0; }
.receipt { width:175mm; min-height:285mm; padding:5mm; margin:0 auto; font-family:'Times New Roman', serif; font-size:11pt; line-height:1.2; }
.receipt table { font-size:11pt; font-family:'Times New Roman', serif; }
.receipt .center { text-align:center; }
.receipt .fs20 { font-size:20px; }
.receipt .inline { display:inline-block; }
.receipt-hint { font-size:12px; }
.receipt-name-line { text-align:center; border-bottom:1px solid #000; width:80%; }
.receipt-caption { border-bottom:1px solid #000; margin-left:20px; font-size:10px; }
.receipt-underline { border-bottom:1px solid #000; padding:0 8px; }
.receipt-extra-line { display:block; margin-left:13px; border-bottom:1px solid #000; min-height:18px; }
.receipt-empty-line { display:block; border-bottom:1px solid #000; min-height:18px; }
.receipt-footer { width:100%; border:0; border-collapse:collapse; }
.no-print { margin:18px auto; display:flex; gap:12px; justify-content:center; }
.no-print button { padding:10px 24px; font-size:14px; cursor:pointer; background:#636C8D; color:#fff; border:none; border-radius:6px; }
@media print { .no-print { display:none; } body { margin:0; } }
</style></head><body>
<section class="receipt">
    <div class="center fs20">
        МИНОБРНАУКИ РОССИИ<br>
        Федеральное государственное бюджетное образовательное учреждение высшего образования<br>
        <b>«Гжельский государственный университет»</b>
    </div>
    <br>
    <div class="center fs20">РАСПИСКА №
        <u>&nbsp;${escapeHtml(manual.regNumber || p.studentId || '')}&nbsp;</u><br>
        <span>о приёме документов</span><br>
        <span class="receipt-hint">(в случае утери расписки следует немедленно сообщить в ГГУ)</span>
    </div>
    <br><br>
    <div class="inline">Получены от гр.&nbsp;</div>
    <div class="inline receipt-name-line"><b>${escapeHtml(p.fullName || '')}</b></div>
    <div class="center"><span class="receipt-caption">(фамилия, имя, отчество полностью)</span></div>
    <br>
    <div>следующие документы:</div>
    <br>
    <div>1. Заявление о приёме</div>
    <br>
    <div>2. Документ об образовании
        <span class="receipt-underline">${escapeHtml(education.kind || education.section || '')}</span>
        <br>
        выдан <span class="receipt-underline">${escapeHtml(manual.eduIssuer || '')}</span>
        &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
        <span class="receipt-underline">Серия&nbsp;${escapeHtml(education.series || '')}&nbsp;№&nbsp;${escapeHtml(education.number || '')}</span>
        &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
        <label>оригинал <input type="radio" name="vo-receipt-edu-doc"></label>
        <label>копия <input type="radio" name="vo-receipt-edu-doc"></label>
    </div>
    <br>
    <div>3. Копия документа, удостоверяющего личность/гражданство</div>
    <br>
    <div>4. _____ фотографии (3×4)</div>
    <br>
    <div>5. Медицинская справка СЭМД 196</div>
    <br>
    <div>6. Выписка из трудовой книжки (копия трудовой книжки)</div>
    <br>
    <div>7. Копия СНИЛС</div>
    <br>
    <div>8. Копия документа, подтверждающего смену фамилии</div>
    <br>
    <div>9. <span class="receipt-extra-line">&nbsp;</span></div>
    <br>
    <div><span class="receipt-empty-line"></span></div>
    <br>
    <div><span class="receipt-empty-line"></span></div>
    <br>
    <div><span class="receipt-empty-line"></span></div>
    <br>
    <table class="receipt-footer">
        <tr valign="bottom">
            <td width="50%">Ответственный сотрудник приемной комиссии</td>
            <td width="30%">_______________________</td>
            <td align="right"><br><u>&nbsp;${receiptDate}&nbsp;</u>&nbsp;г.</td>
        </tr>
    </table>
</section>
<div class="no-print">
    <button onclick="window.print()">🖨️ Распечатать</button>
    <button onclick="window.close()" style="background:#999;">✖️ Закрыть</button>
</div>
</body></html>`;
    }

    function generateCaseInventoryHTML(data) {
        const p = data.profile;
        const education = data.education?.[0] || {};

        return `<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8">
<title>Опись документов личного дела — ${escapeHtml(p.fullName)}</title>
<style>
@page { size: A4 portrait; margin: 15mm; }
body { background:#fff; margin:0; }
.case-inventory { width:175mm; min-height:270mm; padding:5mm; margin:0 auto; font-family:'Times New Roman', serif; box-sizing:border-box; }
.case-inventory table { font-size:14pt; font-family:'Times New Roman', serif; }
.case-inventory p { margin:10px 0; }
.case-name-line { display:inline-block; width:100%; border-bottom:1px solid #000; }
.case-caption { border-bottom:1px solid #000; }
.case-underline { border-bottom:1px solid #000; padding:0 8px; }
.case-empty-line { display:block; margin-left:20px; border-bottom:1px solid #000; min-height:18px; }
.no-print { margin:18px auto; display:flex; gap:12px; justify-content:center; }
.no-print button { padding:10px 24px; font-size:14px; cursor:pointer; background:#636C8D; color:#fff; border:none; border-radius:6px; }
@media print { .no-print { display:none; } body { margin:0; } }
</style></head><body>
<section class="case-inventory">
    <table>
        <tr><td align="center"><font size="4">ОПИСЬ ДОКУМЕНТОВ ЛИЧНОГО ДЕЛА</font></td></tr>
        <tr>
            <td align="center">
                <br>
                <span class="case-name-line"><font size="4"><b>${escapeHtml(p.fullName || '')}</b></font></span>
            </td>
        </tr>
        <tr><td align="center"><span class="case-caption"><font size="1">(фамилия, имя, отчество полностью)</font></span></td></tr>
        <tr>
            <td valign="top">
                <br>
                <p>1. Заявление о приёме <input type="checkbox"></p>
                <p>2. Контактные данные абитуриента <input type="checkbox"></p>
                <p>3. Письменные работы <input type="checkbox"></p>
                <p>4. Документ об образовании <br>
                    <span class="case-underline">${escapeHtml(education.kind || education.section || '')}</span>&nbsp;&nbsp;&nbsp;&nbsp;
                    <label>оригинал <input type="radio" name="vo-case-edu-doc"></label>
                    <label>копия <input type="radio" name="vo-case-edu-doc"></label>
                </p>
                <p>5. Копия паспорта <input type="checkbox"></p>
                <p>6. _____ фотографии (3×4) <input type="checkbox"></p>
                <p>7. СНИЛС <input type="checkbox"></p>
                <p>8. Медицинская справка СЭМД – 196 <input type="checkbox"> /Копия действующей мед. книжки <input type="checkbox">.</p>
                <p>9. Копия трудовой книжки <input type="checkbox"> / Справка с места работы <input type="checkbox">.</p>
                <p>10. Копия документа, подтверждающего смену фамилии <input type="checkbox">.</p>
                <p>11. Согласие на зачисление <input type="checkbox">.</p>
                <p>12.<span class="case-empty-line"></span></p>
                <p><span class="case-empty-line"></span></p>
                <p>13.<span class="case-empty-line"></span></p>
                <p><span class="case-empty-line"></span></p>
                <p>14.<span class="case-empty-line"></span></p>
                <p><span class="case-empty-line"></span></p>
            </td>
        </tr>
    </table>
</section>
<div class="no-print">
    <button onclick="window.print()">🖨️ Распечатать</button>
    <button onclick="window.close()" style="background:#999;">✖️ Закрыть</button>
</div>
</body></html>`;
    }

    function generateDormitoryApplicationHTML(data) {
        const p = profileWithManual(data.profile, loadManual(data.profile));
        const allComps = [];
        for (const app of data.applications || []) {
            for (const c of app.competitions || []) allComps.push({ ...c, appKind: app.kind });
        }
        allComps.sort((a, b) => {
            const pa = parseInt(a.priority || '99', 10);
            const pb = parseInt(b.priority || '99', 10);
            if (pa !== pb) return pa - pb;
            if (a.appKind !== b.appKind) return a.appKind === 'budget' ? -1 : 1;
            return 0;
        });
        const firstComp = allComps[0] || {};
        const direction = [firstComp.direction, firstComp.program].filter(Boolean).join(' ');
        const currentYear = new Date().getFullYear();
        const academicYear = `${currentYear}/${String(currentYear + 1).slice(-2)}`;

        return `<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8">
<title>Заявление на общежитие — ${escapeHtml(p.fullName)}</title>
<style>
@page { size: A4; margin: 15mm; }
body { width:175mm; min-height:270mm; margin:10px auto; background:#fff; font-family:"Times New Roman", serif; font-size:12pt; }
.right { text-align:right; }
.center { text-align:center; }
.line { border-bottom:1px solid #000; display:inline-block; min-width:70mm; padding:0 4px; text-align:center; }
.wide-line { border-bottom:1px solid #000; display:inline; padding:0 4px; }
.small { font-size:13px; }
.signature { width:100%; margin-top:42px; border-collapse:collapse; }
.signature td { vertical-align:bottom; }
.sign-line { border-bottom:1px solid #000; height:20px; }
.no-print { margin:18px auto; display:flex; gap:12px; justify-content:center; }
.no-print button { padding:10px 24px; font-size:14px; cursor:pointer; background:#636C8D; color:#fff; border:none; border-radius:6px; }
@media print { .no-print { display:none; } body { margin:0 auto; } }
</style></head><body>
    <p class="right">Ректору ФГБОУ ВО ГГУ</p>
    <p class="right">Сомову Д.С.</p>
    <p class="right">от <span class="line">${escapeHtml(p.fullName || '')}</span></p>
    <p class="right">Направление подготовки/</p>
    <p class="right">специальность</p>
    <p class="right"><span class="line">${escapeHtml(direction || '')}</span></p>
    <p class="right">Тел. <u>${escapeHtml(p.phone || '')}</u></p>

    <p>&nbsp;</p>
    <p class="center">ЗАЯВЛЕНИЕ</p>

    <p style="text-align:justify;">Прошу предоставить место в общежитии на ${escapeHtml(academicYear)} учебный год. С Правилами внутреннего распорядка общежития ГГУ ознакомлен (а) и обязуюсь их выполнять.</p>

    <p style="text-align:justify;">Зарегистрирован (а) по адресу: <span class="wide-line">${escapeHtml(p.regAddress || '')}</span></p>
    <p style="text-align:justify;">Место жительства (фактич.): <span class="wide-line">${escapeHtml(p.factAddress || p.regAddress || '')}</span></p>

    <table class="signature">
        <tr>
            <td width="15%"><div class="sign-line"></div></td>
            <td width="35%"></td>
            <td width="15%"><div class="sign-line"></div></td>
            <td width="35%"></td>
        </tr>
        <tr>
            <td><p class="small center">дата</p></td>
            <td></td>
            <td><p class="small center">подпись</p></td>
            <td></td>
        </tr>
    </table>

    <div class="no-print">
        <button onclick="window.print()">🖨️ Распечатать</button>
        <button onclick="window.close()" style="background:#999;">✖️ Закрыть</button>
    </div>
</body></html>`;
    }

    function generatePaidContractHTML(data, manual) {
        const p = profileWithManual(data.profile, manual);
        const pass = data.passport || {};
        const contract = manual.contract || {};
        const paidComps = [];
        for (const app of data.applications || []) {
            for (const c of app.competitions || []) {
                const comp = { ...c, appKind: app.kind };
                if (comp.appKind === 'paid' || /плат|договор|внебюдж/i.test(`${comp.placeType || ''} ${comp.status || ''}`)) {
                    paidComps.push(comp);
                }
            }
        }
        const selectedComp = paidComps.find(c => contractCompKey(c) === contract.compKey) || paidComps[0] || {};
        const contractNumber = contract.number || '';
        const contractCustomer = contract.customer || p.fullName || '';
        const applicantFullName = p.fullName || '';
        const applicantShortName = shortFio(applicantFullName);
        const contractCustomerShortName = shortFio(contractCustomer);
        const contractPriceValue = contract.price || tuitionPriceForComp(selectedComp) || '';
        const contractPrice = formatMoney(contractPriceValue) || '________________';
        const contractPriceWords = moneyToWordsRu(contractPriceValue) || '________________';
        const contractYearPriceNumber = Number(String(contractPriceValue || '').replace(/[^\d]/g, ''));
        const contractHalfPriceValue = contractYearPriceNumber ? Math.round(contractYearPriceNumber / 2) : '';
        const contractHalfPrice = formatMoney(contractHalfPriceValue) || '________________';
        const contractHalfPriceWords = moneyToWordsRu(contractHalfPriceValue) || '________________';
        const contractTerm = contract.term || contractTermForComp(selectedComp) || '________________';
        const contractYears = contractYearsCeil(contractTerm);
        const contractFullPriceValue = contractYears && contractYearPriceNumber ? contractYearPriceNumber * contractYears : '';
        const contractFullPrice = formatMoney(contractFullPriceValue) || '________________';
        const contractFullPriceWords = moneyToWordsRu(contractFullPriceValue) || '________________';
        const contractFirstPaymentDate = contract.firstPaymentDate || '«____» __________ 20__ г.';
        const contractSecondPaymentDate = contract.secondPaymentDate || '«____» __________ 20__ г.';
        const contractNextFirstPaymentDate = contract.nextFirstPaymentDate || '«____» __________';
        const contractNextSecondPaymentDate = contract.nextSecondPaymentDate || '«____» __________';
        const customerPassport = contract.customerPassport || {};
        const contractCustomerPassport = passportContractLine(customerPassport, customerPassport.issuedBy);
        const applicantPassportLine = passportContractLine(pass, manual.passportIssuedBy);
        const contractCustomerAddress = contract.customerAddress || p.regAddress || '';
        const contractProgram = selectedComp.program || selectedComp.direction || '__________________________________________';
        const contractDirection = [
            selectedComp.form,
            selectedComp.direction,
            selectedComp.placeType,
        ].filter(Boolean).join(', ') || '__________________________________________';
        const storageKey = manualStorageKey(data.profile);

        return `<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8">
<title>Договор на платное обучение — ${escapeHtml(p.fullName || '')}</title>
<style>
@page { size:A4; margin:12mm; }
body { background:#fff; margin:0; }
.paid-contract { width:175mm; min-height:280mm; margin:0 auto; font-family:'Times New Roman', serif; font-size:11pt; line-height:1.18; }
.paid-contract p { text-align:justify; text-indent:1cm; margin:4px 0; }
.paid-contract h3 { text-align:center; font-size:11pt; margin:16px 0 6px; }
.contract-title { text-align:center; font-size:11pt; font-weight:bold; }
.contract-place { display:flex; justify-content:space-between; margin:10px 0; }
.contract-line { border-bottom:1px solid #000; font-style:italic; font-weight:bold; text-align:center; padding:0 5px; min-height:16px; }
.contract-caption { font-size:9pt; font-style:italic; text-align:center; margin-bottom:3px; }
.contract-date-input { width:42mm; border:0; border-bottom:1px solid #000; padding:0 2mm; font-family:'Times New Roman', serif; font-size:11pt; text-align:center; background:#fffbe8; }
.contract-date-input:focus { outline:1px solid #636C8D; background:#fff; }
.contract-parties { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-top:10px; font-size:10pt; overflow-wrap:anywhere; page-break-inside:avoid; }
.contract-parties div { border-top:1px solid #000; padding-top:4px; }
.contract-bottom-signs { width:175mm; border-collapse:collapse; margin:16px 0 6px; font-size:11pt; }
.contract-bottom-signs td { width:33.33%; padding:5px 6px; vertical-align:bottom; text-align:left; }
.contract-bottom-signs .contract-sign-names td { font-size:10pt; padding-top:0; }
.contract-stamp { text-indent:0 !important; margin:8px 0 !important; }
.contract-executor { width:100%; margin-top:15px; font-size:14px; }
.contract-executor-caption { text-indent:70mm; font-size:14px; }
.no-print { margin:18px auto; display:flex; gap:12px; justify-content:center; }
.no-print button { padding:10px 24px; font-size:14px; cursor:pointer; background:#636C8D; color:#fff; border:none; border-radius:6px; }
@media print { .no-print { display:none; } body { margin:0; } .contract-date-input { background:transparent; outline:0; } }
</style></head><body>
<section class="paid-contract">
    <div class="contract-title">ДОГОВОР № <u>&nbsp;${escapeHtml(contractNumber || '_____')}&nbsp;</u></div>
    <div class="contract-title">об образовании на обучение по образовательным программам</div>
    <div class="contract-title">высшего образования</div>
    <div class="contract-place"><span>Пос. Электроизолятор</span><span>«____» __________ 202__ г.</span></div>

    <p>Федеральное государственное бюджетное образовательное учреждение высшего образования «Гжельский государственный университет» (ГГУ), осуществляющее образовательную деятельность на основании лицензии и свидетельства о государственной аккредитации, именуемое в дальнейшем «Исполнитель», в лице ректора Сомова Дениса Сергеевича, действующего на основании Устава,</p>
    <div class="contract-line">${escapeHtml(contractCustomer)}</div>
    <div class="contract-caption">(фамилия, имя, отчество Заказчика)</div>
    <p>именуемая(ый) в дальнейшем «Заказчик», и</p>
    <div class="contract-line">${escapeHtml(applicantFullName)}</div>
    <div class="contract-caption">(фамилия, имя, отчество лица, зачисляемого на обучение)</div>
    <p>именуемый в дальнейшем «Обучающийся», совместно именуемые Стороны, заключили настоящий Договор о нижеследующем:</p>

    <h3>I. Предмет Договора</h3>
    <p>1.1. Исполнитель обязуется предоставить образовательную услугу, а Обучающийся/Заказчик обязуется оплатить обучение по образовательной программе</p>
    <div class="contract-line">${escapeHtml(contractProgram)}</div>
    <div class="contract-caption">(наименование образовательной программы высшего образования)</div>
    <div class="contract-line">${escapeHtml(contractDirection)}</div>
    <div class="contract-caption">(форма обучения, код, направление подготовки / специальность)</div>
    <p>в пределах федерального государственного образовательного стандарта или образовательного стандарта в соответствии с учебными планами, в том числе индивидуальными, и образовательными программами Исполнителя.</p>
    <p>1.2. Срок освоения образовательной программы на момент подписания Договора составляет <u>&nbsp;${escapeHtml(contractTerm)}&nbsp;</u>. Срок обучения по индивидуальному учебному плану, в том числе ускоренному обучению, составляет __________________________.</p>
    <p>1.3. После освоения Обучающимся образовательной программы и успешного прохождения государственной итоговой аттестации ему выдается документ об образовании и о квалификации установленного образца.</p>

    <h3>II. Взаимодействие сторон</h3>
    <p>2.1. Исполнитель вправе самостоятельно осуществлять образовательный процесс, выбирать системы оценок, формы, порядок и периодичность промежуточной аттестации Обучающегося.</p>
    <p>2.2. Заказчик вправе получать информацию от Исполнителя по вопросам организации и обеспечения надлежащего предоставления услуг, предусмотренных разделом I настоящего Договора.</p>
    <p>2.3. Обучающемуся предоставляются академические права в соответствии с Федеральным законом от 29 декабря 2012 г. № 273-ФЗ «Об образовании в Российской Федерации».</p>
    <p>2.4. Исполнитель обязан зачислить Обучающегося, выполнившего установленные законодательством Российской Федерации, учредительными документами, локальными нормативными актами Исполнителя условия приема, в качестве студента.</p>
    <p>2.5. Заказчик и (или) Обучающийся обязаны своевременно вносить плату за предоставляемые образовательные услуги в размере и порядке, определенных настоящим Договором.</p>

    <h3>III. Стоимость образовательных услуг, сроки и порядок их оплаты</h3>
    <p>3.1. Полная стоимость образовательных услуг за весь период обучения Обучающегося составляет <u>&nbsp;${escapeHtml(contractFullPrice)}&nbsp;</u> рублей (${escapeHtml(contractFullPriceWords)}). В соответствии со ст. 149 НК РФ стоимость услуг НДС не облагается.</p>
    <p>3.2. Стоимость образовательных услуг за первый год обучения составляет <u>&nbsp;${escapeHtml(contractPrice)}&nbsp;</u> рублей (${escapeHtml(contractPriceWords)}).</p>
    <p>Оплата производится в следующем порядке:</p>
    <p>- за первый год обучения <u>&nbsp;${escapeHtml(contractHalfPrice)}&nbsp;</u> (${escapeHtml(contractHalfPriceWords)}) рублей до <input class="contract-date-input contract-date-first" value="${escapeHtml(contractFirstPaymentDate)}">, и <u>&nbsp;${escapeHtml(contractHalfPrice)}&nbsp;</u> (${escapeHtml(contractHalfPriceWords)}) рублей до <input class="contract-date-input contract-date-second" value="${escapeHtml(contractSecondPaymentDate)}">;</p>
    <p>- за второй и последующие учебные годы оплата производится до <input class="contract-date-input contract-date-next-first" value="${escapeHtml(contractNextFirstPaymentDate)}"> и до <input class="contract-date-input contract-date-next-second" value="${escapeHtml(contractNextSecondPaymentDate)}">, в размере половины стоимости обучения в текущем учебном году.</p>
    <p>3.3. Приказ о зачислении Обучающегося издается после поступления оплаты за обучение на расчетный счет или в кассу Исполнителя.</p>
    <p>3.4. Увеличение стоимости платных образовательных услуг после заключения Договора не допускается, за исключением увеличения стоимости с учетом уровня инфляции, предусмотренного законодательством Российской Федерации.</p>

    <h3>IV. Порядок изменения и расторжения Договора</h3>
    <p>4.1. Условия, на которых заключен настоящий Договор, могут быть изменены по соглашению Сторон или в соответствии с законодательством Российской Федерации.</p>
    <p>4.2. Настоящий Договор может быть расторгнут по соглашению Сторон.</p>
    <p>4.3. Настоящий Договор может быть расторгнут по инициативе Исполнителя в случаях, предусмотренных законодательством Российской Федерации.</p>

    <h3>V. Ответственность сторон и порядок рассмотрения споров</h3>
    <p>5.1. За неисполнение или ненадлежащее исполнение обязательств по Договору Стороны несут ответственность, предусмотренную законодательством Российской Федерации и настоящим Договором.</p>
    <p>5.2. Все споры по настоящему Договору разрешаются Сторонами путем переговоров, а при невозможности достижения согласия - в судебном порядке по месту нахождения Исполнителя.</p>

    <h3>VI. Срок действия Договора</h3>
    <p>Настоящий Договор вступает в силу со дня его заключения Сторонами и действует до полного исполнения Сторонами обязательств.</p>

    <h3>VII. Заключительные положения</h3>
    <p>7.1. Сведения, указанные в настоящем Договоре, соответствуют информации, размещенной на официальном сайте Исполнителя в сети Интернет на дату заключения настоящего Договора.</p>
    <p>7.2. Настоящий Договор составлен в 2 экземплярах, по одному для каждой из Сторон. Все экземпляры имеют одинаковую юридическую силу.</p>

    <h3>VIII. Адреса и реквизиты Сторон</h3>
    <div class="contract-parties">
        <div><b>Исполнитель</b><br>ГГУ<br>Адрес: 140155 Московская область, Раменский м.о., пос. Электроизолятор, д. 67<br>ИНН/КПП 5040036468/504001001<br>Тел./факс: 8-496-464-76-40<br>Ректор</div>
        <div><b>Заказчик</b><br>ФИО: ${escapeHtml(contractCustomer)}<br>Адрес регистрации: ${escapeHtml(contractCustomerAddress)}<br>Паспортные данные: ${escapeHtml(contractCustomerPassport)}<br>Тел.: __________________</div>
        <div><b>Обучающийся</b><br>ФИО: ${escapeHtml(applicantFullName)}<br>Адрес регистрации: ${escapeHtml(p.regAddress || '')}<br>Паспортные данные: ${escapeHtml(applicantPassportLine)}<br>Тел.: ${escapeHtml(p.phone || '__________________')}</div>
    </div>
    <table class="contract-bottom-signs">
        <tr><td>Ректор</td><td>Заказчик</td><td>Обучающийся</td></tr>
        <tr><td>________________</td><td>________________</td><td>________________</td></tr>
        <tr class="contract-sign-names"><td>Д.С. Сомов</td><td>${escapeHtml(contractCustomerShortName)}</td><td>${escapeHtml(applicantShortName)}</td></tr>
    </table>
    <p class="contract-stamp">М.П.</p>
    <div class="contract-executor">Исполнитель ______________________/______________________</div>
    <div class="contract-executor-caption">(подпись) &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; (ФИО)</div>
</section>
<div class="no-print">
    <button onclick="window.print()">🖨️ Распечатать</button>
    <button onclick="window.close()" style="background:#999;">✖️ Закрыть</button>
</div>
<script>
(() => {
    const storageKey = ${JSON.stringify(storageKey)};
    const save = (field, value) => {
        try {
            const data = JSON.parse(localStorage.getItem(storageKey) || '{}');
            data.contract = data.contract || {};
            data.contract[field] = value.trim();
            data.updatedAt = new Date().toISOString();
            localStorage.setItem(storageKey, JSON.stringify(data));
        } catch (e) {}
    };
    document.querySelector('.contract-date-first')?.addEventListener('input', e => save('firstPaymentDate', e.target.value));
    document.querySelector('.contract-date-second')?.addEventListener('input', e => save('secondPaymentDate', e.target.value));
    document.querySelector('.contract-date-next-first')?.addEventListener('input', e => save('nextFirstPaymentDate', e.target.value));
    document.querySelector('.contract-date-next-second')?.addEventListener('input', e => save('nextSecondPaymentDate', e.target.value));
})();
</script>
</body></html>`;
    }

    // =====================================================================
    // ОТКРЫТИЕ ОКНА С ДОКУМЕНТОМ
    // =====================================================================

    function openDocWindow(html, title) {
        const win = window.open('', '_blank');
        if (!win) {
            alert('Разрешите всплывающие окна для этого сайта');
            return;
        }
        win.document.open();
        win.document.write(html);
        win.document.close();
        win.document.title = title;
    }

    // =====================================================================
    // ОБРАБОТЧИКИ КНОПОК
    // =====================================================================

    async function handleApplication() {
        try {
            const data = await enrichDocumentIssuers(collectAll());
            if (!data.applications.length) {
                alert('У абитуриента нет заявлений');
                return;
            }
            openModal(data, (manual) => {
                const html = generateApplicationHTML(data, manual);
                openDocWindow(html, `Заявление № ${manual.regNumber || data.profile.studentId}`);
            });
        } catch (e) {
            console.error(e);
            alert('Ошибка: ' + e.message);
        }
    }

    async function handleConsent() {
        try {
            const data = await enrichDocumentIssuers(collectAll());
            openModal(data, (manual) => {
                const html = generateConsentHTML(data, manual);
                openDocWindow(html, 'Согласие на обработку ПД');
            });
        } catch (e) {
            console.error(e);
            alert('Ошибка: ' + e.message);
        }
    }

    async function handleTitlePage() {
        try {
            const data = await enrichDocumentIssuers(collectAll());
            openModal(data, (manual) => {
                const html = generateTitlePageHTML(data, manual);
                openDocWindow(html, `Личное дело № ${data.profile.studentId}`);
            });
        } catch (e) {
            console.error(e);
            alert('Ошибка: ' + e.message);
        }
    }

    async function handleReceipt() {
        try {
            const data = await enrichDocumentIssuers(collectAll());
            openModal(data, (manual) => {
                const html = generateReceiptHTML(data, manual);
                openDocWindow(html, `Расписка — ${data.profile.fullName}`);
            });
        } catch (e) {
            console.error(e);
            alert('Ошибка: ' + e.message);
        }
    }

    function handleCaseInventory() {
        try {
            const data = collectAll();
            const html = generateCaseInventoryHTML(data);
            openDocWindow(html, `Опись документов — ${data.profile.fullName}`);
        } catch (e) {
            console.error(e);
            alert('Ошибка: ' + e.message);
        }
    }

    function handleDormitoryApplication() {
        try {
            const data = collectAll();
            const html = generateDormitoryApplicationHTML(data);
            openDocWindow(html, `Заявление на общежитие — ${data.profile.fullName}`);
        } catch (e) {
            console.error(e);
            alert('Ошибка: ' + e.message);
        }
    }

    async function handlePaidContract() {
        try {
            const data = await enrichDocumentIssuers(collectAll());
            const paidComps = (data.applications || [])
                .flatMap(app => (app.competitions || []).map(c => ({ ...c, appKind: app.kind })))
                .filter(c => c.appKind === 'paid' || /плат|договор|внебюдж/i.test(`${c.placeType || ''} ${c.status || ''}`));
            if (!paidComps.length) {
                alert('У абитуриента нет платных направлений для договора');
                return;
            }
            openModal(data, (manual) => {
                const html = generatePaidContractHTML(data, manual);
                openDocWindow(html, `Договор на платное обучение — ${data.profile.fullName}`);
            });
        } catch (e) {
            console.error(e);
            alert('Ошибка: ' + e.message);
        }
    }

    function handleExamSheet() {
        try {
            const data = collectAll();
            const { enrollments } = data.entranceExams || { enrollments: [] };
            if (!enrollments.length) {
                alert('У абитуриента нет записи на вступительные испытания (нет строк с датой и временем)');
                return;
            }
            const savedManual = loadManual(data.profile);
            const sheetNum = prompt('Номер экзаменационного листа (можно оставить пустым):', savedManual.examSheetNumber || '') ?? '';
            saveManual(data.profile, { examSheetNumber: sheetNum.trim() });
            const html = generateExamSheetHTML(data, sheetNum.trim());
            openDocWindow(html, `Экзаменационный лист — ${data.profile.fullName}`);
        } catch (e) {
            console.error(e);
            alert('Ошибка: ' + e.message);
        }
    }

    function openAllDisclosures() {
        let opened = 0;
        const clicked = new WeakSet();
        const pass = () => {
            const sections = $$('section.group\\/disclosure, section[class*="group/disclosure"]');
            for (const section of sections) {
                if (clicked.has(section)) continue;
                const button = sectionHeaderControl(section);
                if (!button) continue;
                const expanded = section.getAttribute('aria-expanded') || button.getAttribute('aria-expanded');
                const content = sectionContentElement(section);
                const contentClass = content?.className || '';
                const contentStyle = content?.getAttribute('style') || '';
                const looksClosed = expanded !== 'true'
                    || String(contentClass).includes('grid-rows-0')
                    || /height:\s*0|opacity:\s*0|display:\s*none/i.test(contentStyle);
                if (looksClosed) {
                    clicked.add(section);
                    button.click();
                    opened += 1;
                }
            }
        };
        pass();
        setTimeout(pass, 250);
        setTimeout(pass, 600);
        setTimeout(() => {
            pass();
            alert(opened ? `Открыто разделов: ${opened}` : 'Все разделы уже открыты');
        }, 1000);
    }

    // =====================================================================
    // ВЫПАДАЮЩЕЕ МЕНЮ + ЗАЩИТА ОТ РЕ-РЕНДЕРА
    // =====================================================================

    const DROPDOWN_ID = 'ggu-docs-dropdown';

    function addButtons() {
        const target = document.querySelector('main header div.flex.items-center.gap-3')
            || document.querySelector('header div.flex.items-center.gap-3');
        if (!target) return;
        if (document.getElementById(DROPDOWN_ID)) return;

        const wrapper = document.createElement('div');
        wrapper.id = DROPDOWN_ID;
        wrapper.style.cssText = 'position:relative; display:inline-block; margin-left:4px;';

        const mainBtn = document.createElement('button');
        mainBtn.type = 'button';
        mainBtn.textContent = '📋 Документы ▾';
        mainBtn.style.cssText = `padding:6px 14px; border-radius:8px; border:none;
            background:#636C8D; color:#fff; cursor:pointer; font-size:13px; font-weight:600;`;

        const panel = document.createElement('div');
        panel.style.cssText = `display:none; position:absolute; right:0; top:calc(100% + 4px);
            background:#fff; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,.22);
            min-width:215px; z-index:99998; overflow:hidden;`;

        const items = [
            { label: '↕️ Открыть все разделы',    handler: openAllDisclosures },
            { label: '📄 Заявление',            handler: handleApplication },
            { label: '🔏 Согласие ПД',           handler: handleConsent     },
            { label: '📁 Титульный лист',         handler: handleTitlePage   },
            { label: '🧾 Расписка',               handler: handleReceipt     },
            { label: '📂 Опись документов',       handler: handleCaseInventory },
            { label: '🏠 Заявление на общежитие', handler: handleDormitoryApplication },
            { label: '💳 Договор на платное обучение', handler: handlePaidContract },
            { label: '📝 Экзаменационный лист',  handler: handleExamSheet   },
        ];

        items.forEach((item, i) => {
            const el = document.createElement('button');
            el.type = 'button';
            el.textContent = item.label;
            el.style.cssText = `display:block; width:100%; padding:9px 14px;
                background:#fff; border:none;
                border-bottom:${i < items.length - 1 ? '1px solid #f0f0f0' : 'none'};
                cursor:pointer; font-size:13px; text-align:left; color:#333;`;
            el.addEventListener('mouseenter', () => { el.style.background = '#f0f4ff'; });
            el.addEventListener('mouseleave', () => { el.style.background = '#fff'; });
            el.addEventListener('click', () => { panel.style.display = 'none'; item.handler(); });
            panel.appendChild(el);
        });

        mainBtn.addEventListener('click', e => {
            e.stopPropagation();
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        });
        document.addEventListener('click', () => { panel.style.display = 'none'; });

        wrapper.appendChild(mainBtn);
        wrapper.appendChild(panel);
        target.appendChild(wrapper);
    }

    // SPA — следим за DOM, чтобы меню не пропадало при перерисовке
    const observer = new MutationObserver(() => {
        if (!document.getElementById(DROPDOWN_ID)) addButtons();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', addButtons);
    } else {
        addButtons();
    }
    setTimeout(addButtons, 1500);

})();
