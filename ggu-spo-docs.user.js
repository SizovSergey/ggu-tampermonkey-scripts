// ==UserScript==
// @name         ГГУ — СПО Документы абитуриента
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Собирает данные по вкладкам заявления СПО и формирует комплект документов
// @match        *://*/spo/admission/applications/*/*
// @match        *://*/spo/admission/entrants/*/personal*
// @updateURL    https://raw.githubusercontent.com/SizovSergey/ggu-tampermonkey-scripts/main/ggu-spo-docs.user.js
// @downloadURL  https://raw.githubusercontent.com/SizovSergey/ggu-tampermonkey-scripts/main/ggu-spo-docs.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const PANEL_ID = 'ggu-spo-doc-panel';
    const MODAL_ID = 'ggu-spo-doc-modal';
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    function txt(el, def = '') {
        return el ? el.textContent.trim().replace(/\s+/g, ' ') : def;
    }

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function unique(list) {
        const seen = new Set();
        return list.filter(item => {
            const key = JSON.stringify(item);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    const ENTRANCE_DISCIPLINES = [
        'Рисунок',
        'Живопись',
        'Физическая культура',
        'Творческий экзамен (НХТ)',
        'Творческий экзамен (СКД)',
    ];

    const TUITION_PRICES = {
        fullTime: {
            '08.02.01': 143830,
            '09.02.12': 143830,
            '18.02.05': 143830,
            '38.02.01': 140700,
            '40.02.04': 140700,
            '43.02.16': 140700,
            '49.02.01': 149860,
            '51.02.01': 149860,
            '51.02.02': 149860,
            '54.02.01': 390400,
            '54.02.02': 390400,
            '54.02.05': 390400,
            '54.02.07': 390400,
            '44.02.03': 140700,
        },
        partTime: {
            '08.02.01': 53560,
            '38.02.01': 53560,
            '40.02.04': 53560,
            '43.02.16': 53560,
            '49.02.01': 53560,
        },
    };

    const TUITION_TERMS = {
        basicGeneral: {
            '08.02.01': '3 года 10 месяцев',
            '09.02.12': '2 года 10 месяцев',
            '18.02.05': '3 года 10 месяцев',
            '38.02.01': '2 года 10 месяцев',
            '40.02.04': '2 года 10 месяцев',
            '43.02.16': '2 года 10 месяцев',
            '44.02.03': '3 года 10 месяцев',
            '49.02.01': '3 года 10 месяцев',
            '51.02.01': '3 года 10 месяцев',
            '51.02.02': '3 года 10 месяцев',
            '54.02.01': '3 года 10 месяцев',
            '54.02.02': '3 года 10 месяцев',
            '54.02.05': '3 года 10 месяцев',
        },
        secondaryGeneral: {
            '08.02.01': '2 года 10 месяцев',
            '18.02.05': '2 года 10 месяцев',
            '38.02.01': '1 год 10 месяцев',
            '40.02.04': '1 год 10 месяцев',
            '43.02.16': '1 год 10 месяцев',
            '49.02.01': '2 года 10 месяцев',
            '51.02.02': '2 года 10 месяцев',
        },
    };

    function specialityCode(value) {
        return (value || '').match(/\b\d{2}\.\d{2}\.\d{2}\b/)?.[0] || '';
    }

    function tuitionFormKey(value) {
        const text = (value || '').toLowerCase();
        if (/заоч/.test(text)) return 'partTime';
        return 'fullTime';
    }

    function educationBaseKey(educationDoc) {
        const text = `${educationDoc?.section || ''} ${educationDoc?.kind || ''}`.toLowerCase();
        if (/средн\w*\s+общ/.test(text)) return 'secondaryGeneral';
        return 'basicGeneral';
    }

    function tuitionPriceForSpec(spec) {
        const code = specialityCode(spec?.program || spec?.speciality || '');
        const formKey = tuitionFormKey(spec?.form || '');
        return TUITION_PRICES[formKey]?.[code] || '';
    }

    function tuitionTermForSpec(spec, educationDoc) {
        const code = specialityCode(spec?.program || spec?.speciality || '');
        const baseKey = educationBaseKey(educationDoc);
        return TUITION_TERMS[baseKey]?.[code] || '';
    }

    function contractSpecKey(spec) {
        return [
            specialityCode(spec?.program || spec?.speciality || ''),
            spec?.program || '',
            spec?.form || '',
            spec?.funding || '',
            spec?.status || '',
        ].join('|');
    }

    function passportDocLine(doc, includeKind = true) {
        return [
            includeKind ? (doc?.kind || 'Паспорт') : '',
            doc?.series ? `серия ${doc.series}` : '',
            doc?.number ? `№ ${doc.number}` : '',
            doc?.departmentCode ? `код подразделения ${doc.departmentCode}` : '',
            doc?.date ? `выдан ${doc.date}` : '',
            doc?.issuedBy || '',
        ].filter(Boolean).join(', ');
    }

    function shortFio(fullName) {
        const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return '';
        const [lastName, firstName = '', middleName = ''] = parts;
        const initials = [firstName, middleName]
            .filter(Boolean)
            .map(part => `${part[0]}.`)
            .join('');
        return initials ? `${lastName} ${initials}` : lastName;
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
        const monthsMatch = text.match(/(\d+)\s*(?:месяц|месяца|месяцев)/);
        const years = yearsMatch ? Number(yearsMatch[1]) : 0;
        const months = monthsMatch ? Number(monthsMatch[1]) : 0;
        if (!years && !months) return 0;
        return years + (months > 0 ? 1 : 0);
    }

    function normalizeEntranceSubject(value) {
        const raw = normalizeValue(value);
        const found = ENTRANCE_DISCIPLINES.find(name => name.toLowerCase() === raw.toLowerCase());
        return found || raw;
    }

    function splitEntranceDateTime(value) {
        const m = (value || '').match(/(\d{2})\.(\d{2})\.(\d{4})(?:\s*(?:в|В)\s*(\d{1,2}:\d{2}))?/);
        if (!m) return { date: '', time: '', display: normalizeValue(value) };
        const date = `${m[3]}-${m[2]}-${m[1]}`;
        const time = m[4] ? m[4].padStart(5, '0') : '';
        return { date, time, display: `${m[1]}.${m[2]}.${m[3]}${time ? ` в ${time}` : ''}` };
    }

    function formatEntranceDateTime(test) {
        if (test.display) return test.display;
        if (!test.date) return '';
        const m = String(test.date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const date = m ? `${m[3]}.${m[2]}.${m[1]}` : test.date;
        return `${date}${test.time ? ` в ${test.time}` : ''}`;
    }

    function appIdFromLocation() {
        const m = location.pathname.match(/\/spo\/admission\/applications\/(\d+)/);
        return m ? m[1] : '';
    }

    function entrantIdFromLocation() {
        const m = location.pathname.match(/\/spo\/admission\/entrants\/(\d+)/);
        return m ? m[1] : '';
    }

    function storageKey(appId = appIdFromLocation()) {
        return `ggu-spo-docs:${appId || 'unknown'}`;
    }

    function personalStorageKey(entrantId) {
        return `ggu-spo-personal:${entrantId || 'unknown'}`;
    }

    function loadData() {
        try {
            return JSON.parse(localStorage.getItem(storageKey()) || sessionStorage.getItem(storageKey()) || '{}');
        } catch {
            return {};
        }
    }

    function saveData(patch) {
        const current = loadData();
        const merged = {
            ...current,
            ...patch,
            updatedAt: new Date().toISOString(),
        };
        localStorage.setItem(storageKey(merged.application?.id || appIdFromLocation()), JSON.stringify(merged));
        return merged;
    }

    function loadPersonal(entrantId) {
        try {
            return JSON.parse(localStorage.getItem(personalStorageKey(entrantId)) || sessionStorage.getItem(personalStorageKey(entrantId)) || '{}');
        } catch {
            return {};
        }
    }

    function savePersonal(entrantId, patch) {
        const current = loadPersonal(entrantId);
        const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
        localStorage.setItem(personalStorageKey(entrantId), JSON.stringify(merged));
        return merged;
    }

    function getSectionName() {
        const path = location.pathname;
        if (path.endsWith('/main')) return 'main';
        if (path.endsWith('/documents')) return 'documents';
        if (path.endsWith('/speciality')) return 'speciality';
        if (path.endsWith('/individual_achievements')) return 'achievements';
        if (path.endsWith('/preferences')) return 'preferences';
        if (path.endsWith('/entrance-test')) return 'entranceTest';
        if (/\/spo\/admission\/entrants\/\d+\/personal/.test(path)) return 'personal';
        return 'unknown';
    }

    function normalizeValue(value) {
        const v = (value || '').replace(/\s+/g, ' ').trim();
        return /^не указан$/i.test(v) ? '' : v;
    }

    function valueByLabel(label, root = document) {
        const labels = $$('p', root).filter(p => txt(p).toLowerCase().includes(label.toLowerCase()));
        for (const lab of labels) {
            const parent = lab.parentElement;
            if (!parent) continue;
            const clone = parent.cloneNode(true);
            clone.querySelectorAll('button, svg').forEach(el => el.remove());
            const labText = txt(lab).toLowerCase();
            const clonedLabel = $$('p', clone).find(p => txt(p).toLowerCase() === labText);
            if (clonedLabel) clonedLabel.remove();
            const value = normalizeValue(txt(clone) || txt(parent).replace(txt(lab), '').trim());
            if (value) return value;
        }
        return '';
    }

    function dateByLabel(label, root = document) {
        const value = valueByLabel(label, root);
        const m = value.match(/\b\d{2}\.\d{2}\.\d{4}\b/);
        return m ? m[0] : value;
    }

    function collectCommon() {
        const appId = appIdFromLocation() || txt($('h1 + span')).replace(/[^\d]/g, '');
        const entrantLink = $('a[href*="/spo/admission/entrants/"][href$="/personal"]');
        const entrantHref = entrantLink?.getAttribute('href') || '';
        const entrantId = (entrantHref.match(/\/entrants\/(\d+)\/personal/) || [])[1] || entrantIdFromLocation();
        const fullName = txt(entrantLink?.querySelector('span')) || txt(entrantLink) || txt($('.LsOE_3uz1lM3_FCD span'));

        const headerItems = $$('main div').filter(d => {
            const t = txt(d);
            return t && d.children.length <= 2 && !t.includes('Заявление') && !t.includes('Основная информация');
        });
        const birthday = (document.body.textContent.match(/\b\d{2}\.\d{2}\.\d{4}\b/) || [])[0] || '';
        const levelType = headerItems.map(txt).find(t => /^Колледж|Техникум|Училище$/i.test(t)) || 'Колледж';
        const status = txt($('[aria-label*="историю"] span')) || '';
        const [lastName = '', firstName = '', middleName = ''] = fullName.split(/\s+/);

        return {
            id: appId,
            entrantId,
            entrantHref,
            fullName,
            lastName,
            firstName,
            middleName,
            birthday,
            levelType,
            status,
        };
    }

    function collectPersonal() {
        const common = collectCommon();
        const profilePatch = {
            gender: valueByLabel('Пол'),
            birthday: dateByLabel('Дата рождения') || common.birthday,
            snils: valueByLabel('СНИЛС'),
            phone: valueByLabel('Телефон'),
            email: valueByLabel('Email'),
            birthPlace: valueByLabel('Место рождения'),
            regAddress: valueByLabel('Адрес постоянной регистрации'),
            factAddress: valueByLabel('Адрес фактического проживания'),
            representativeName: valueByLabel('ФИО представителя'),
            representativePhone: valueByLabel('Телефон представителя'),
            representativeEmail: valueByLabel('Email представителя'),
        };
        const entrantId = common.entrantId || entrantIdFromLocation();
        const savedPersonal = savePersonal(entrantId, profilePatch);
        return {
            application: {
                ...loadData().application,
                ...common,
                birthday: profilePatch.birthday || common.birthday || loadData().application?.birthday || '',
            },
            profilePatch: savedPersonal,
            collected: { ...(loadData().collected || {}), personal: true },
        };
    }

    function collectMain() {
        const application = collectCommon();
        return {
            application,
            main: {
                registrationDate: valueByLabel('Дата и время регистрации'),
                needsHostel: /^да$/i.test(valueByLabel('Необходимость общежития')),
                hasDisability: valueByLabel('Имеются ограниченные возможности'),
                firstSpecialEducation: valueByLabel('Первое специальное образование'),
            },
            collected: { ...(loadData().collected || {}), main: true },
        };
    }

    function parseDocumentBlock(section) {
        const sectionTitle = txt(section.querySelector('h4'));
        const card = $('[role="button"][aria-label*="документ"]', section) || section;
        const kind = txt(card.querySelector('h5'));
        const numberParagraph = $$('p', card).find(p => {
            if (p.closest('button')) return false;
            const spans = $$(':scope > span', p).map(span => txt(span)).filter(Boolean);
            return spans.length > 0 && !/Дата|Выдан|Статус|Р”Р°С‚Р°|Р’С‹РґР°РЅ|РЎС‚Р°С‚СѓСЃ/i.test(txt(p));
        });
        const spanParts = numberParagraph
            ? $$(':scope > span', numberParagraph).map(span => txt(span)).filter(Boolean)
            : [];
        const rawNumber = spanParts.length
            ? spanParts.join(' ')
            : txt(card.querySelector('p span')?.parentElement);
        const numberParts = rawNumber.split(/\s+/).filter(Boolean);
        const isPassport = /паспорт|личност/i.test(`${sectionTitle} ${kind}`);
        const passportSeriesInTwoParts = isPassport && numberParts.length >= 3 && /^\d{2}$/.test(numberParts[0]) && /^\d{2}$/.test(numberParts[1]);
        const series = passportSeriesInTwoParts
            ? numberParts.slice(0, 2).join(' ')
            : numberParts.length > 1 ? numberParts[0] : '';
        const number = passportSeriesInTwoParts
            ? numberParts.slice(2).join(' ')
            : numberParts.length > 1 ? numberParts.slice(1).join(' ') : rawNumber;
        return {
            section: sectionTitle,
            kind,
            series,
            number,
            date: valueByLabel('Дата выдачи', card),
            departmentCode: valueByLabel('Код подразделения', card),
            issuedBy: valueByLabel('Выдан', card),
            status: valueByLabel('Статус', card),
        };
    }

    function inferCitizenship(passportKind) {
        if (/Российской Федерации|РФ|Россия/i.test(passportKind || '')) return 'РОССИЯ';
        if (/иностран/i.test(passportKind || '')) return 'Иностранное государство';
        return '';
    }

    function collectDocuments() {
        const sections = $$('h4').map(h => h.closest('div')).filter(Boolean);
        const docs = sections
            .map(parseDocumentBlock)
            .filter(d => d.kind || d.number || d.date);
        const passport = docs.find(d => /паспорт|личност/i.test(`${d.section} ${d.kind}`)) || {};
        const education = docs.find(d => /образован|аттестат|диплом/i.test(`${d.section} ${d.kind}`)) || {};
        return {
            documents: { all: docs, passport, education },
            profilePatch: { citizenship: inferCitizenship(passport.kind) },
            collected: { ...(loadData().collected || {}), documents: true },
        };
    }

    function collectSpecialities() {
        const table = $('table');
        if (!table) return { specialities: [], collected: { ...(loadData().collected || {}), speciality: true } };
        const rows = $$('.ant-table-tbody tr.ant-table-row', table)
            .filter(tr => !$(':scope > td[colspan]', tr));
        const specialities = rows.map(tr => {
            const tds = $$(':scope > td', tr);
            return {
                id: txt(tds[0]),
                program: txt(tds[1]),
                educationLevel: txt(tds[2]),
                form: txt(tds[3]),
                funding: txt(tds[4]),
                budgetLevel: txt(tds[5]),
                status: txt(tds[6]),
                comment: txt(tds[7]),
            };
        }).filter(s => /^\d+$/.test(s.id) && s.program && !/Образовательная программа/i.test(s.program));
        return {
            specialities: unique(specialities),
            collected: { ...(loadData().collected || {}), speciality: true },
        };
    }

    function cleanSelectedItemText(value) {
        return normalizeValue(value)
            .replace(/\s*Удалить\s*$/i, '')
            .replace(/\s*РЈРґР°Р»РёС‚СЊ\s*$/i, '')
            .trim();
    }

    function collectSelectedListItems() {
        const cardItems = $$('li')
            .filter(li => {
                if (li.closest('.ant-modal, .ant-select-dropdown, .ant-popover, [role="tooltip"]')) return false;
                return !!li.querySelector('button[data-danger="true"]');
            })
            .map(li => cleanSelectedItemText(txt(li.querySelector('p') || li)))
            .filter(Boolean);
        const compactItems = $$('.TTLojS85gEstNArJ')
            .filter(card => {
                if (card.closest('.ant-modal, .ant-select-dropdown, .ant-popover, [role="tooltip"]')) return false;
                return !!card.querySelector('button[data-danger="true"]');
            })
            .map(card => cleanSelectedItemText(txt(card.querySelector('p') || card)))
            .filter(Boolean);
        return unique([...cardItems, ...compactItems]);
    }

    function collectAchievements() {
        return {
            achievements: unique(collectSelectedListItems()).map(name => ({ name })),
            collected: { ...(loadData().collected || {}), achievements: true },
        };
    }

    function collectPreferences() {
        return {
            preferences: unique(collectSelectedListItems()).map(name => ({ name })),
            collected: { ...(loadData().collected || {}), preferences: true },
        };
    }

    function collectEntranceTest() {
        const rows = $$('.ant-table-tbody tr.ant-table-row')
            .map(tr => {
                const tds = $$(':scope > td', tr);
                const parsedDate = splitEntranceDateTime(txt(tds[3]));
                return {
                    specialityId: txt(tds[0]),
                    speciality: txt(tds[1]),
                    subject: normalizeEntranceSubject(txt(tds[2])),
                    date: parsedDate.date,
                    time: parsedDate.time,
                    display: parsedDate.display,
                    place: txt(tds[4]),
                };
            })
            .filter(item => item.subject || item.display || item.place);
        return {
            entranceTests: rows,
            collected: { ...(loadData().collected || {}), entranceTest: true },
        };
    }

    function collectCurrentPage() {
        const section = getSectionName();
        let patch = {};
        if (section === 'personal') {
            const data = collectPersonal();
            return saveData(data);
        }
        if (section === 'main') patch = collectMain();
        if (section === 'documents') patch = collectDocuments();
        if (section === 'speciality') patch = collectSpecialities();
        if (section === 'achievements') patch = collectAchievements();
        if (section === 'preferences') patch = collectPreferences();
        if (section === 'entranceTest') patch = collectEntranceTest();

        const common = collectCommon();
        const personal = common.entrantId ? loadPersonal(common.entrantId) : {};
        if (common.id || common.fullName) patch.application = { ...(loadData().application || {}), ...common };
        if (Object.keys(personal).length) {
            patch.profilePatch = { ...(loadData().profilePatch || {}), ...personal, ...(patch.profilePatch || {}) };
            patch.collected = { ...(patch.collected || loadData().collected || {}), personal: true };
        }
        return saveData(patch);
    }

    function completedCount(data) {
        const c = data.collected || {};
        return ['personal', 'main', 'documents', 'speciality', 'achievements', 'preferences', 'entranceTest'].filter(k => c[k]).length;
    }

    function panelUiKey() {
        return 'ggu-spo-doc-panel-ui';
    }

    function loadPanelUi() {
        try {
            return JSON.parse(localStorage.getItem(panelUiKey()) || '{}');
        } catch {
            return {};
        }
    }

    function savePanelUi(patch) {
        const current = loadPanelUi();
        localStorage.setItem(panelUiKey(), JSON.stringify({ ...current, ...patch }));
    }

    function enablePanelControls(panel) {
        const ui = loadPanelUi();
        const head = $('.head', panel);
        if (head && !$('#ggu-spo-toggle', panel)) {
            const title = txt(head);
            head.textContent = '';
            const titleEl = document.createElement('span');
            titleEl.className = 'title';
            titleEl.textContent = title;
            const toggleEl = document.createElement('button');
            toggleEl.id = 'ggu-spo-toggle';
            toggleEl.type = 'button';
            toggleEl.title = 'Свернуть';
            toggleEl.textContent = '-';
            head.append(titleEl, toggleEl);
        }
        const toggle = $('#ggu-spo-toggle', panel);
        if (ui.left !== undefined && ui.top !== undefined) {
            panel.style.left = `${ui.left}px`;
            panel.style.top = `${ui.top}px`;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        }
        if (ui.collapsed) {
            panel.classList.add('collapsed');
            if (toggle) toggle.textContent = '+';
        }

        toggle?.addEventListener('click', e => {
            e.stopPropagation();
            const collapsed = panel.classList.toggle('collapsed');
            toggle.textContent = collapsed ? '+' : '-';
            savePanelUi({ collapsed });
        });

        head?.addEventListener('pointerdown', e => {
            if (e.target.closest('button')) return;
            const rect = panel.getBoundingClientRect();
            const shiftX = e.clientX - rect.left;
            const shiftY = e.clientY - rect.top;
            panel.style.left = `${rect.left}px`;
            panel.style.top = `${rect.top}px`;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            head.setPointerCapture(e.pointerId);

            const move = ev => {
                const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
                const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
                const left = Math.min(Math.max(0, ev.clientX - shiftX), maxLeft);
                const top = Math.min(Math.max(0, ev.clientY - shiftY), maxTop);
                panel.style.left = `${left}px`;
                panel.style.top = `${top}px`;
            };
            const up = ev => {
                head.releasePointerCapture(ev.pointerId);
                head.removeEventListener('pointermove', move);
                head.removeEventListener('pointerup', up);
                const finalRect = panel.getBoundingClientRect();
                savePanelUi({ left: Math.round(finalRect.left), top: Math.round(finalRect.top) });
            };
            head.addEventListener('pointermove', move);
            head.addEventListener('pointerup', up);
        });
    }

    function enableModalDrag(overlay) {
        const modal = $('.modal', overlay);
        const head = $('h2', modal);
        if (!modal || !head) return;
        head.addEventListener('pointerdown', e => {
            const rect = modal.getBoundingClientRect();
            const shiftX = e.clientX - rect.left;
            const shiftY = e.clientY - rect.top;
            modal.style.transform = 'none';
            modal.style.left = `${rect.left}px`;
            modal.style.top = `${rect.top}px`;
            head.setPointerCapture(e.pointerId);

            const move = ev => {
                const maxLeft = Math.max(0, window.innerWidth - modal.offsetWidth);
                const maxTop = Math.max(0, window.innerHeight - modal.offsetHeight);
                const left = Math.min(Math.max(0, ev.clientX - shiftX), maxLeft);
                const top = Math.min(Math.max(0, ev.clientY - shiftY), maxTop);
                modal.style.left = `${left}px`;
                modal.style.top = `${top}px`;
            };
            const up = ev => {
                head.releasePointerCapture(ev.pointerId);
                head.removeEventListener('pointermove', move);
                head.removeEventListener('pointerup', up);
            };
            head.addEventListener('pointermove', move);
            head.addEventListener('pointerup', up);
        });
    }

    function addPanel() {
        if (document.getElementById(PANEL_ID)) return;
        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.innerHTML = `
            <style>
                #${PANEL_ID} {
                    position: fixed; right: 16px; bottom: 16px; z-index: 99998;
                    width: 280px; background: #fff; color: #222;
                    border: 1px solid #d8dbe8; border-radius: 10px;
                    box-shadow: 0 8px 30px rgba(0,0,0,.22);
                    font: 13px/1.35 Arial, sans-serif; overflow: hidden;
                }
                #${PANEL_ID} .head { background: #636C8D; color: #fff; padding: 9px 12px; font-weight: 700; display: flex; align-items: center; gap: 8px; cursor: move; user-select: none; }
                #${PANEL_ID} .head .title { flex: 1; min-width: 0; }
                #${PANEL_ID} .head button { width: 24px; height: 24px; padding: 0; border-radius: 6px; background: rgba(255,255,255,.18); color: #fff; line-height: 1; }
                #${PANEL_ID} .body { padding: 10px 12px; display: grid; gap: 8px; }
                #${PANEL_ID}.collapsed .body { display: none; }
                #${PANEL_ID}.collapsed { width: 210px; }
                #${PANEL_ID} .status { color: #555; font-size: 12px; }
                #${PANEL_ID} .buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
                #${PANEL_ID} button { border: 0; border-radius: 7px; padding: 8px; cursor: pointer; font-weight: 600; }
                #${PANEL_ID} .primary { background: #636C8D; color: #fff; }
                #${PANEL_ID} .secondary { background: #eef0f7; color: #30364f; }
                #${PANEL_ID} .danger { background: #fff1f1; color: #9b1c1c; }
                #${PANEL_ID} ul { margin: 0; padding-left: 18px; }
                #${PANEL_ID} select {
                    width: 100%; border: 1px solid #d8dbe8; border-radius: 7px;
                    padding: 7px 8px; font: inherit; background: #fff;
                }
            </style>
            <div class="head">Документы СПО</div>
            <div class="body">
                <div class="status" id="ggu-spo-status"></div>
                <select id="ggu-spo-doc-type">
                    <option value="package">Комплект документов</option>
                    <option value="application">Заявление</option>
                    <option value="consent">Согласие ПД</option>
                    <option value="title">Титульный лист</option>
                    <option value="receipt">Расписка</option>
                    <option value="examSheet">Экзаменационный лист</option>
                    <option value="caseInventory">Опись документов личного дела</option>
                    <option value="paidContract">Договор на платное обучение</option>
                </select>
                <div class="buttons">
                    <button class="secondary" id="ggu-spo-save">Собрать</button>
                    <button class="primary" id="ggu-spo-build">Сформировать</button>
                    <button class="danger" id="ggu-spo-clear">Очистить</button>
                    <button class="secondary" id="ggu-spo-debug">Данные</button>
                </div>
            </div>
        `;
        document.body.appendChild(panel);
        enablePanelControls(panel);
        $('#ggu-spo-save', panel).addEventListener('click', () => {
            const data = collectCurrentPage();
            renderPanel(data);
        });
        $('#ggu-spo-build', panel).addEventListener('click', () => {
            const docType = $('#ggu-spo-doc-type', panel)?.value || 'package';
            openManualModal(loadData(), docType);
        });
        $('#ggu-spo-clear', panel).addEventListener('click', () => {
            localStorage.removeItem(storageKey());
            sessionStorage.removeItem(storageKey());
            renderPanel({});
        });
        $('#ggu-spo-debug', panel).addEventListener('click', () => openDocWindow(debugHtml(loadData()), 'Данные СПО'));
        renderPanel(loadData());
    }

    function renderPanel(data) {
        const status = $('#ggu-spo-status');
        if (!status) return;
        const c = data.collected || {};
        const names = [
            ['main', 'осн. инфо'],
            ['personal', 'перс. данные'],
            ['documents', 'документы'],
            ['speciality', 'специальности'],
            ['achievements', 'ИД'],
            ['preferences', 'льготы'],
            ['entranceTest', 'ВИ'],
        ];
        status.innerHTML = `
            <div><b>${escapeHtml(data.application?.fullName || 'Поступающий не определен')}</b></div>
            <div>Собрано: ${completedCount(data)} / ${names.length}</div>
            <ul>${names.map(([k, n]) => `<li>${c[k] ? '✓' : '□'} ${n}</li>`).join('')}</ul>
        `;
    }

    function isMinor(birthday) {
        const m = (birthday || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
        if (!m) return false;
        const bd = new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00`);
        return (Date.now() - bd.getTime()) / (365.25 * 24 * 3600 * 1000) < 18;
    }

    function openManualModal(data, docType = 'package') {
        const old = document.getElementById(MODAL_ID);
        if (old) old.remove();

        const p = data.application || {};
        const main = data.main || {};
        const profile = data.profilePatch || {};
        const docs = data.documents || {};
        const savedManual = data.manual || {};
        const savedContract = savedManual.contract || {};
        const preferencesSource = savedManual.preferences?.length ? savedManual.preferences : data.preferences || [];
        const preferencesText = preferencesSource.map(p => p.name).filter(Boolean).join('\n');
        const modalPassport = savedManual.passport || docs.passport || {};
        const modalSpecs = (data.specialities || []).filter(s => specialityCode(s.program || s.speciality || ''));
        const modalPaidSpecs = modalSpecs.filter(s => /плат|договор|внебюдж/i.test(`${s.funding} ${s.status}`));
        const modalContractSpecs = modalPaidSpecs.length ? modalPaidSpecs : modalSpecs;
        const modalPaidSpec = modalContractSpecs.find(s => contractSpecKey(s) === savedContract.specKey) || modalContractSpecs[0] || {};
        const modalContractPrice = savedContract.price || formatMoney(tuitionPriceForSpec(modalPaidSpec));
        const modalContractTerm = savedContract.term || tuitionTermForSpec(modalPaidSpec, docs.education);
        const contractSpecOptions = modalContractSpecs.map((spec, index) => {
            const key = contractSpecKey(spec) || String(index);
            const price = tuitionPriceForSpec(spec);
            const term = tuitionTermForSpec(spec, docs.education);
            const labelParts = [
                spec.program || spec.speciality || '',
                spec.form || '',
                spec.funding || '',
            ].filter(Boolean);
            return `<option value="${escapeHtml(key)}" data-price="${escapeHtml(price)}" data-term="${escapeHtml(term)}" ${key === savedContract.specKey ? 'selected' : ''}>${escapeHtml(labelParts.join(' | '))}</option>`;
        }).join('');
        const minor = isMinor(p.birthday);
        const entranceSource = savedManual.entranceTests?.length ? savedManual.entranceTests : data.entranceTests || [];
        const entranceDefaults = [
            ...entranceSource,
            { subject: '', date: '', time: '', place: '' },
            { subject: '', date: '', time: '', place: '' },
            { subject: '', date: '', time: '', place: '' },
        ];
        const entranceSubjectOptions = selected => ENTRANCE_DISCIPLINES
            .map(name => `<option value="${escapeHtml(name)}" ${name === normalizeEntranceSubject(selected) ? 'selected' : ''}>${escapeHtml(name)}</option>`)
            .join('');
        const entranceRowsHtml = entranceDefaults.map((test, i) => `
            <div class="vi-row">
                <select class="spo-vi-subject">
                    <option value=""></option>
                    ${entranceSubjectOptions(test.subject)}
                </select>
                <input class="spo-vi-date" type="date" value="${escapeHtml(test.date || '')}">
                <input class="spo-vi-time" type="time" value="${escapeHtml(test.time || '')}">
                <input class="spo-vi-place" value="${escapeHtml(test.place || '')}" placeholder="Место">
            </div>
        `).join('');
        const modalCustomerPassport = savedContract.customerPassportParts || modalPassport;
        const overlay = document.createElement('div');
        overlay.id = MODAL_ID;
        overlay.innerHTML = `
            <style>
                #${MODAL_ID} { position: fixed; inset: 0; z-index: 99999; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; font-family: Arial, sans-serif; }
                #${MODAL_ID} .modal { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); background: #fff; width: min(760px, 94vw); max-height: 90vh; overflow: auto; border-radius: 10px; padding: 22px; box-shadow: 0 10px 40px rgba(0,0,0,.3); }
                #${MODAL_ID} h2 { margin: 0 0 12px; font-size: 18px; cursor: move; user-select: none; }
                #${MODAL_ID} h3 { margin: 16px 0 8px; font-size: 13px; color: #636C8D; text-transform: uppercase; }
                #${MODAL_ID} .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
                #${MODAL_ID} label { display: flex; flex-direction: column; gap: 4px; margin-bottom: 9px; font-size: 13px; color: #444; }
                #${MODAL_ID} input, #${MODAL_ID} textarea, #${MODAL_ID} select { border: 1px solid #d5d8e4; border-radius: 7px; padding: 8px 10px; font: inherit; background:#fff; }
                #${MODAL_ID} .vi-head, #${MODAL_ID} .vi-row { display: grid; grid-template-columns: 1.4fr 130px 100px 1.2fr; gap: 8px; align-items: center; }
                #${MODAL_ID} .vi-head { font-size: 12px; color:#666; margin-bottom: 4px; }
                #${MODAL_ID} .vi-row { margin-bottom: 7px; }
                #${MODAL_ID} .actions { display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid #eee; padding-top: 14px; margin-top: 16px; }
                #${MODAL_ID} button { border: 0; border-radius: 7px; padding: 9px 16px; cursor: pointer; font-weight: 700; }
                #${MODAL_ID} .primary { background: #636C8D; color: #fff; }
                #${MODAL_ID} .secondary { background: #eef0f7; color: #30364f; }
            </style>
            <div class="modal">
                <h2>Уточните данные для комплекта СПО</h2>
                <h3>Профиль</h3>
                <div class="row">
                    <label>Гражданство <input id="spo-citizenship" value="${escapeHtml(savedManual.citizenship || profile.citizenship || '')}"></label>
                    <label>Дата рождения <input id="spo-birthday" value="${escapeHtml(savedManual.birthday || profile.birthday || p.birthday || '')}"></label>
                    <label>СНИЛС <input id="spo-snils" value="${escapeHtml(savedManual.snils || profile.snils || '')}"></label>
                    <label>Телефон <input id="spo-phone" value="${escapeHtml(savedManual.phone || profile.phone || '')}"></label>
                    <label>Email <input id="spo-email" value="${escapeHtml(savedManual.email || profile.email || '')}"></label>
                </div>
                <label>Место рождения <input id="spo-birthplace" value="${escapeHtml(savedManual.birthPlace || profile.birthPlace || '')}"></label>
                <label>Адрес регистрации <textarea id="spo-reg-address">${escapeHtml(savedManual.regAddress || profile.regAddress || '')}</textarea></label>
                <label>Адрес фактического проживания <textarea id="spo-fact-address">${escapeHtml(savedManual.factAddress || profile.factAddress || '')}</textarea></label>

                <h3>Документы</h3>
                <div class="row">
                    <label>Документ личности <input id="spo-passport-kind" value="${escapeHtml(modalPassport.kind || 'Паспорт')}"></label>
                    <label>Серия <input id="spo-passport-series" value="${escapeHtml(modalPassport.series || '')}"></label>
                </div>
                <div class="row">
                    <label>Номер <input id="spo-passport-number" value="${escapeHtml(modalPassport.number || '')}"></label>
                    <label>Код подразделения <input id="spo-passport-code" value="${escapeHtml(modalPassport.departmentCode || '')}"></label>
                </div>
                <div class="row">
                    <label>Дата выдачи <input id="spo-passport-date" value="${escapeHtml(modalPassport.date || '')}"></label>
                    <label>Кем выдан <input id="spo-passport-issued" value="${escapeHtml(modalPassport.issuedBy || '')}"></label>
                </div>
                <label>Образовательная организация, выдавшая документ <input id="spo-edu-issuer" value="${escapeHtml(docs.education?.issuedBy || '')}"></label>
                <label>Особые права / льготы <textarea id="spo-preferences" placeholder="Каждая льгота с новой строки">${escapeHtml(preferencesText)}</textarea></label>

                <h3>Дополнительно</h3>
                <div class="row">
                    <label style="display:flex; flex-direction:row; align-items:center; gap:8px;">
                        <input type="radio" name="spo-hostel" value="0" ${!(savedManual.needsHostel ?? main.needsHostel) ? 'checked' : ''}>
                        Не нуждаюсь в общежитии
                    </label>
                    <label style="display:flex; flex-direction:row; align-items:center; gap:8px;">
                        <input type="radio" name="spo-hostel" value="1" ${(savedManual.needsHostel ?? main.needsHostel) ? 'checked' : ''}>
                        Нуждаюсь в общежитии
                    </label>
                </div>
                <div class="row">
                    <label>Регистрационный номер <input id="spo-reg-number" value="${escapeHtml(savedManual.regNumber || p.id || '')}"></label>
                    <label>Иностранный язык <input id="spo-foreign-lang" value="${escapeHtml(savedManual.foreignLang || '')}"></label>
                </div>
                <h3>Вступительные испытания</h3>
                <div class="vi-head">
                    <span>Дисциплина</span>
                    <span>Дата</span>
                    <span>Время</span>
                    <span>Место</span>
                </div>
                ${entranceRowsHtml}
                <h3>Договор на платное обучение</h3>
                <label>Платное направление
                    <select id="spo-contract-spec">
                        ${contractSpecOptions || '<option value="">Нет платных направлений</option>'}
                    </select>
                </label>
                <div class="row">
                    <label>Номер договора <input id="spo-contract-number" value="${escapeHtml(savedContract.number || '')}"></label>
                    <label>Стоимость за первый год <input id="spo-contract-price" value="${escapeHtml(modalContractPrice)}" placeholder="например: 120000"></label>
                </div>
                <div class="row">
                    <label>Срок обучения <input id="spo-contract-term" value="${escapeHtml(modalContractTerm)}" placeholder="например: 3 года 10 месяцев"></label>
                    <label>Заказчик <input id="spo-contract-customer" value="${escapeHtml(savedContract.customer || p.fullName || '')}"></label>
                </div>
                <h3>Паспорт заказчика</h3>
                <div class="row">
                    <label>Серия <input id="spo-contract-customer-passport-series" value="${escapeHtml(modalCustomerPassport.series || '')}"></label>
                    <label>Номер <input id="spo-contract-customer-passport-number" value="${escapeHtml(modalCustomerPassport.number || '')}"></label>
                </div>
                <div class="row">
                    <label>Код подразделения <input id="spo-contract-customer-passport-code" value="${escapeHtml(modalCustomerPassport.departmentCode || '')}"></label>
                    <label>Дата выдачи <input id="spo-contract-customer-passport-date" value="${escapeHtml(modalCustomerPassport.date || '')}"></label>
                </div>
                <label>Кем выдан <input id="spo-contract-customer-passport-issued" value="${escapeHtml(modalCustomerPassport.issuedBy || '')}"></label>
                <label>Адрес заказчика <textarea id="spo-contract-customer-address">${escapeHtml(savedContract.customerAddress || savedManual.regAddress || profile.regAddress || '')}</textarea></label>
                ${minor ? `
                    <h3>Законный представитель</h3>
                    <label>ФИО представителя <input id="spo-rep-name" value="${escapeHtml(profile.representativeName || '')}"></label>
                    <div class="row">
                        <label>Документ <input id="spo-rep-doc" value="Паспорт гражданина РФ"></label>
                        <label>Серия и номер <input id="spo-rep-number"></label>
                    </div>
                    <label>Кем и когда выдан <input id="spo-rep-issued"></label>
                ` : ''}
                <div class="actions">
                    <button class="secondary" id="spo-cancel">Отмена</button>
                    <button class="primary" id="spo-ok">Сформировать</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        enableModalDrag(overlay);
        const close = () => overlay.remove();
        $('#spo-cancel', overlay).addEventListener('click', close);
        $('#spo-contract-spec', overlay)?.addEventListener('change', e => {
            const selected = e.target.selectedOptions[0];
            const price = selected?.dataset.price || '';
            const term = selected?.dataset.term || '';
            $('#spo-contract-price', overlay).value = formatMoney(price);
            $('#spo-contract-term', overlay).value = term;
        });
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        $('#spo-ok', overlay).addEventListener('click', () => {
            const manual = {
                citizenship: $('#spo-citizenship', overlay).value.trim(),
                birthday: $('#spo-birthday', overlay).value.trim(),
                snils: $('#spo-snils', overlay).value.trim(),
                phone: $('#spo-phone', overlay).value.trim(),
                email: $('#spo-email', overlay).value.trim(),
                birthPlace: $('#spo-birthplace', overlay).value.trim(),
                regAddress: $('#spo-reg-address', overlay).value.trim(),
                factAddress: $('#spo-fact-address', overlay).value.trim(),
                passport: {
                    kind: $('#spo-passport-kind', overlay).value.trim(),
                    series: $('#spo-passport-series', overlay).value.trim(),
                    number: $('#spo-passport-number', overlay).value.trim(),
                    departmentCode: $('#spo-passport-code', overlay).value.trim(),
                    date: $('#spo-passport-date', overlay).value.trim(),
                    issuedBy: $('#spo-passport-issued', overlay).value.trim(),
                },
                passportIssuedBy: $('#spo-passport-issued', overlay).value.trim(),
                eduIssuer: $('#spo-edu-issuer', overlay).value.trim(),
                preferences: $('#spo-preferences', overlay).value.split(/\n+/).map(cleanSelectedItemText).filter(Boolean).map(name => ({ name })),
                needsHostel: $('input[name="spo-hostel"]:checked', overlay)?.value === '1',
                regNumber: $('#spo-reg-number', overlay).value.trim(),
                foreignLang: $('#spo-foreign-lang', overlay).value.trim(),
                entranceTests: $$('.vi-row', overlay).map(row => ({
                    subject: normalizeEntranceSubject($('.spo-vi-subject', row)?.value || ''),
                    date: $('.spo-vi-date', row)?.value || '',
                    time: $('.spo-vi-time', row)?.value || '',
                    place: $('.spo-vi-place', row)?.value.trim() || '',
                })).filter(test => test.subject || test.date || test.time || test.place),
                contract: {
                    specKey: $('#spo-contract-spec', overlay)?.value || '',
                    number: $('#spo-contract-number', overlay).value.trim(),
                    price: $('#spo-contract-price', overlay).value.trim(),
                    term: $('#spo-contract-term', overlay).value.trim(),
                    customer: $('#spo-contract-customer', overlay).value.trim(),
                    customerPassport: passportDocLine({
                        kind: 'Паспорт',
                        series: $('#spo-contract-customer-passport-series', overlay).value.trim(),
                        number: $('#spo-contract-customer-passport-number', overlay).value.trim(),
                        departmentCode: $('#spo-contract-customer-passport-code', overlay).value.trim(),
                        date: $('#spo-contract-customer-passport-date', overlay).value.trim(),
                        issuedBy: $('#spo-contract-customer-passport-issued', overlay).value.trim(),
                    }, false),
                    customerPassportParts: {
                        kind: 'Паспорт',
                        series: $('#spo-contract-customer-passport-series', overlay).value.trim(),
                        number: $('#spo-contract-customer-passport-number', overlay).value.trim(),
                        departmentCode: $('#spo-contract-customer-passport-code', overlay).value.trim(),
                        date: $('#spo-contract-customer-passport-date', overlay).value.trim(),
                        issuedBy: $('#spo-contract-customer-passport-issued', overlay).value.trim(),
                    },
                    customerAddress: $('#spo-contract-customer-address', overlay).value.trim(),
                },
                representative: minor ? {
                    name: $('#spo-rep-name', overlay).value.trim(),
                    doc: $('#spo-rep-doc', overlay).value.trim(),
                    number: $('#spo-rep-number', overlay).value.trim(),
                    issued: $('#spo-rep-issued', overlay).value.trim(),
                } : null,
            };
            saveData({ manual });
            close();
            openDocWindow(generatePackageHtml(data, manual, docType), `${docTitle(docType)} СПО — ${p.fullName || p.id || ''}`);
        });
    }

    function docTitle(docType) {
        return {
            package: 'Комплект документов',
            application: 'Заявление',
            consent: 'Согласие ПД',
            title: 'Титульный лист',
            receipt: 'Расписка',
            examSheet: 'Экзаменационный лист',
            caseInventory: 'Опись документов личного дела',
            paidContract: 'Договор на платное обучение',
        }[docType] || 'Документ';
    }

    function tableRows(items, render) {
        return items.length ? items.map(render).join('') : '<tr><td colspan="10" style="text-align:center;">Нет данных</td></tr>';
    }

    function generatePackageHtml(data, manual, docType = 'package') {
        const app = data.application || {};
        const main = data.main || {};
        const docs = data.documents || {};
        const passport = docs.passport || {};
        const education = docs.education || {};
        const specs = (data.specialities || []).filter(s =>
            /^\d+$/.test(String(s.id || '')) &&
            s.program &&
            !/Образовательная программа/i.test(s.program) &&
            !/Уровень образования/i.test(s.educationLevel || '') &&
            !/Форма обучения/i.test(s.form || '') &&
            !/Форма оплаты/i.test(s.funding || '') &&
            !/Статус/i.test(s.status || '')
        );
        const hasBudgetSpec = specs.some(s => /бюдж/i.test(`${s.funding} ${s.status}`) && !/внебюдж/i.test(`${s.funding} ${s.status}`));
        const achievements = data.achievements || [];
        const preferences = manual.preferences?.length ? manual.preferences : data.preferences || [];
        const entranceTests = (manual.entranceTests?.length ? manual.entranceTests : data.entranceTests || [])
            .map(test => ({
                ...test,
                subject: normalizeEntranceSubject(test.subject || ''),
                display: formatEntranceDateTime(test),
            }))
            .filter(test => test.subject || test.display || test.place);
        const year = new Date().getFullYear();
        const regNum = manual.regNumber || app.id || '';
        const tick = '✓';
        const citizenship = manual.citizenship || data.profilePatch?.citizenship || '';
        const birthday = manual.birthday || data.profilePatch?.birthday || app.birthday || '';
        const factAddress = manual.factAddress || manual.regAddress || '';
        const manualPassport = manual.passport || {};
        const passportData = {
            ...passport,
            kind: manualPassport.kind || passport.kind || '',
            series: manualPassport.series || passport.series || '',
            number: manualPassport.number || passport.number || '',
            departmentCode: manualPassport.departmentCode || passport.departmentCode || '',
            date: manualPassport.date || passport.date || '',
            issuedBy: manualPassport.issuedBy || manual.passportIssuedBy || passport.issuedBy || '',
        };
        const passportIssued = passportData.issuedBy || '';
        const eduIssuer = manual.eduIssuer || education.issuedBy || '__________________________________________';
        const firstSpec = specs[0] || {};
        const applicantPassportLine = passportDocLine(passportData);
        const applicantContractPassportLine = passportDocLine(passportData, false);

        const personTable = `
            <table class="t bordered">
                <tr>
                    <td width="20%"><b>Фамилия</b></td>
                    <td width="28%"><i>${escapeHtml(app.lastName)}</i></td>
                    <td colspan="4"><b>Документ, удостоверяющий личность</b></td>
                    <td width="25%"><i>${escapeHtml(passportData.kind || '')}</i></td>
                </tr>
                <tr>
                    <td><b>Имя</b></td>
                    <td><i>${escapeHtml(app.firstName)}</i></td>
                    <td width="7%"><b>Серия</b></td>
                    <td width="13%"><i>${escapeHtml(passportData.series || '')}</i></td>
                    <td width="10%"><b>Номер</b></td>
                    <td colspan="2"><i>${escapeHtml(passportData.number || '')}</i></td>
                </tr>
                <tr>
                    <td><b>Отчество</b></td>
                    <td><i>${escapeHtml(app.middleName)}</i></td>
                    <td colspan="2"><b>Когда и кем выдан</b></td>
                    <td colspan="3"><i>${escapeHtml(passportData.date || '')} ${passportData.departmentCode ? `код подразделения ${escapeHtml(passportData.departmentCode)} ` : ''}${escapeHtml(passportIssued)}</i></td>
                </tr>
                <tr>
                    <td><b>Дата рождения</b></td>
                    <td><i>${escapeHtml(birthday)}</i></td>
                    <td colspan="5" rowspan="3"><i>${escapeHtml(manual.birthPlace || '')}</i></td>
                </tr>
                <tr><td><b>Гражданство</b></td><td><i>${escapeHtml(citizenship)}</i></td></tr>
                <tr><td><b>СНИЛС</b></td><td><i>${escapeHtml(manual.snils)}</i></td></tr>
                <tr><td><b>Адрес постоянной регистрации</b></td><td colspan="6"><i>${escapeHtml(manual.regAddress)}</i></td></tr>
                <tr><td><b>Адрес фактического проживания</b></td><td colspan="6"><i>${escapeHtml(factAddress)}</i></td></tr>
                <tr><td><b>Контактный телефон</b></td><td colspan="6"><i>${escapeHtml(manual.phone)}</i></td></tr>
                <tr><td><b>Электронная почта</b></td><td colspan="6"><i>${escapeHtml(manual.email)}</i></td></tr>
            </table>
        `;

        const educationBlock = `
            <div class="text-small" style="margin-top:10px;">
                В Приемную комиссию представлен документ об образовании <span class="div1">(необходимо указать образование, которое вы имеете):</span>
            </div>
            <table class="t bordered" style="text-align:center; margin-top:8px;">
                <tr>
                    <td width="35%"><b>Уровень / тип документа</b></td>
                    <td width="20%"><b>Серия</b></td>
                    <td width="25%"><b>Номер</b></td>
                    <td width="20%"><b>Дата выдачи</b></td>
                </tr>
                <tr>
                    <td style="text-align:left; padding-left:6px;">${escapeHtml(education.section || 'Образование')}${education.kind ? ` <small>(${escapeHtml(education.kind)})</small>` : ''}</td>
                    <td>${escapeHtml(education.series || '')}</td>
                    <td>${escapeHtml(education.number || '')}</td>
                    <td>${escapeHtml(education.date || '')}</td>
                </tr>
            </table>
            <div class="text-small" style="text-align:center; border-bottom:1px solid #000; margin-top:6px;">
                Выдан ${escapeHtml(eduIssuer)}
            </div>
            <div class="text-tiny" style="text-align:center;"><sub>(наименование образовательной организации)</sub></div>
        `;

        const specsTable = `
            <table class="t bordered admission-table">
                <tr style="height:80px;">
                    <td width="10%" class="rotate-priority"><div>№<br>приоритета</div></td>
                    <td width="35%" style="text-align:center; vertical-align:middle;"><div class="div2">Направление подготовки/ специальность</div></td>
                    <td width="15%" style="text-align:center; vertical-align:middle;"><div class="div2">Уровень</div></td>
                    <td width="15%" style="text-align:center; vertical-align:middle;"><div class="div2">Форма обучения</div></td>
                    <td width="25%" style="text-align:center; vertical-align:middle;"><div class="div2">По договору об оказании платных образовательных услуг</div></td>
                </tr>
                ${tableRows(specs, (s, i) => `<tr>
                    <td style="text-align:center; vertical-align:middle;">${i + 1}</td>
                    <td class="div4">${escapeHtml(s.program)}</td>
                    <td style="text-align:center;" class="div4">${escapeHtml(s.educationLevel || 'СПО')}</td>
                    <td style="text-align:center;" class="div4">${escapeHtml(s.form)}</td>
                    <td style="text-align:center;" class="div4"></td>
                </tr>`)}
            </table>
        `;

        const headerHTML = `
            <div class="reg-num">Регистрационный № <u>${escapeHtml(regNum || '_______')} / ${escapeHtml(app.entrantId || '')}</u></div>
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

        const achievementsBlock = achievements.length ? `
            <div class="div2" style="margin-top:10px;">3.&nbsp;&nbsp;Индивидуальные достижения
                <small>(копии документов прилагаются к заявлению)</small>
            </div>
            <table class="t bordered">
                <tr style="text-align:center;">
                    <td width="5%"><div class="div2">№</div></td>
                    <td width="45%"><div class="div2">Наименование достижения</div></td>
                    <td width="50%"><div class="div2">Реквизиты подтверждающих документов (серия, номер, дата выдачи)</div></td>
                </tr>
                ${achievements.map((a, i) => `<tr><td style="text-align:center;">${i + 1}</td><td>${escapeHtml(a.name)}</td><td></td></tr>`).join('')}
            </table>
        ` : '';

        const preferencesBlock = preferences.length ? `
            <div class="div2" style="margin-top:10px;">Особые права / льготы
                <small>(копии документов прилагаются к заявлению)</small>
            </div>
            <table class="t bordered">
                <tr style="text-align:center;">
                    <td width="5%"><div class="div2">№</div></td>
                    <td width="45%"><div class="div2">Наименование льготы / особого права</div></td>
                    <td width="50%"><div class="div2">Подтверждающий документ</div></td>
                </tr>
                ${preferences.map((p, i) => `<tr><td style="text-align:center;">${i + 1}</td><td>${escapeHtml(p.name)}</td><td></td></tr>`).join('')}
            </table>
        ` : '';

        const entranceTestsBlock = entranceTests.length ? `
            <div class="div2" style="margin-top:10px;">2.&nbsp;&nbsp;Прошу допустить к сдаче вступительных испытаний в ГГУ по следующим предметам:</div>
            <div class="div5">
                <table class="t bordered entrance-table">
                    <tr>
                        <td width="5%" style="text-align:center; vertical-align:top;">№</td>
                        <td width="30%" style="text-align:center; vertical-align:top;">Наименование предмета</td>
                        <td width="25%" style="text-align:center; vertical-align:top;">Дата и время проведения</td>
                        <td width="40%" style="text-align:center; vertical-align:top;">Место проведения</td>
                    </tr>
                    ${entranceTests.map((test, i) => `<tr>
                        <td style="text-align:center;">${i + 1}</td>
                        <td>${escapeHtml(test.subject)}</td>
                        <td style="text-align:center;">${escapeHtml(test.display || formatEntranceDateTime(test))}</td>
                        <td>${escapeHtml(test.place || '')}</td>
                    </tr>`).join('')}
                </table>
            </div>
            <div class="div3">- Вступительные испытания проходят на русском языке.</div>
            <div class="div3">- ГГУ может проводить вступительные испытания с использованием дистанционных технологий.</div>
        ` : '';

        const repBlock = manual.representative?.name ? `
            <div style="margin-top:10px; padding:8px; border:1px solid #999;">
                <b>Законный представитель:</b><br>
                ФИО: ${escapeHtml(manual.representative.name)}<br>
                ${escapeHtml(manual.representative.doc)}, ${escapeHtml(manual.representative.number)}, выдан ${escapeHtml(manual.representative.issued)}
            </div>
        ` : '';

        const acknowledgeBlock = `
            <table class="t dashed original-ack" style="margin-top:10px;">
                <tr>
                    <td><div class="div5">Ознакомлен(а) (в том числе через информационные системы общего пользования) с:</div></td>
                    <td width="22%" style="text-align:center;"><div class="div5">подпись поступающего</div></td>
                </tr>
                <tr><td><div class="div5">- копиями устава и лицензии на осуществление образовательной деятельности (с приложениями)</div></td><td></td></tr>
                <tr><td><div class="div5">- копией свидетельства о государственной аккредитации (с приложениями)</div></td><td></td></tr>
                <tr><td><div class="div5">- Правилами приема в ГГУ в ${year} году</div></td><td></td></tr>
                <tr><td><div class="div5">- информацией о предоставляемых особых правах и преимуществах при приеме на обучение</div></td><td></td></tr>
                <tr><td><div class="div5">- датой завершения приема заявления о согласии на зачисление</div></td><td></td></tr>
                <tr><td><div class="div5">- датой заключения договора об образовании</div></td><td></td></tr>
                <tr><td><div class="div5">- правилами подачи апелляции при проведении вступительных испытаний, проводимых университетом самостоятельно</div></td><td></td></tr>
                <tr><td><div class="div5"><span class="div2">Подтверждаю:</span> - достоверность сведений в заявлении о себе</div></td><td></td></tr>
                <tr><td><div class="div5">- получение среднего профессионального образования впервые</div></td><td></td></tr>
            </table>
        `;

        const consentSubjectRows = `
            <tr><td class="lab">Фамилия, имя, отчество</td><td class="val">${escapeHtml(app.fullName)}</td></tr>
            <tr><td class="lab">Дата рождения</td><td class="val">${escapeHtml(birthday)}</td></tr>
            <tr><td class="lab">Место рождения</td><td class="val">${escapeHtml(manual.birthPlace || '')}</td></tr>
            <tr><td class="lab">Адрес регистрации</td><td class="val">${escapeHtml(manual.regAddress)}</td></tr>
            <tr><td class="lab">Документ, удостоверяющий личность</td><td class="val">${escapeHtml(applicantPassportLine)}</td></tr>
            <tr><td class="lab">Кем и когда выдан</td><td class="val">${escapeHtml(passportData.date || '')}${passportData.departmentCode ? `, код подразделения ${escapeHtml(passportData.departmentCode)}` : ''}, ${escapeHtml(passportIssued)}</td></tr>
            <tr><td class="lab">СНИЛС</td><td class="val">${escapeHtml(manual.snils || '')}</td></tr>
            <tr><td class="lab">Контактный телефон</td><td class="val">${escapeHtml(manual.phone || '')}</td></tr>
            <tr><td class="lab">Электронная почта</td><td class="val">${escapeHtml(manual.email || '')}</td></tr>
        `;

        const applicationPage = `
<section class="page">
    ${headerHTML}
    ${personTable}
    ${educationBlock}
    <div class="original-title">ЗАЯВЛЕНИЕ</div>
    <div class="div2" style="font-size:11.5px;">Прошу допустить меня к участию в конкурсе на 1 курс по следующим условиям приема и основаниям приёма:</div>
    ${specsTable}
    ${preferencesBlock}
    ${entranceTestsBlock}
    <br>
    <div class="div5">Прошу обеспечить <b>специальные условия</b> при проведении вступительных испытаний в связи</div>
    <div class="div5">с ограниченными возможностями здоровья / инвалидностью <span class="select-line">&nbsp;</span></div>
    <br>
    ${achievementsBlock}
    <div class="div5" style="margin-top:10px;">В общежитии&nbsp;&nbsp;&nbsp;${!manual.needsHostel ? `${tick} не нуждаюсь` : `${tick} нуждаюсь&nbsp;&nbsp;&nbsp;&nbsp;${tick} c Порядком проживания ознакомлен (а)`}</div>
    <br>
    ${acknowledgeBlock}
    <div style="margin-top:10px;" class="text-small">
        В случае непоступления на обучение в ГГУ прошу вернуть мне оригиналы поданных документов
        (если такие предоставлялись) следующим способом: <u><b>лично</b></u>.
    </div>
    <div style="margin-top:10px;"><b>Иностранный язык:</b>&nbsp;&nbsp;${manual.foreignLang ? `${tick} ${escapeHtml(manual.foreignLang)}` : 'не изучал / не указан'}</div>
    <div class="signature">«______» __________ ${year} г.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Подпись поступающего _________________</div>
    <div style="text-align:right; margin-top:14px;" class="text-small">Ответственный сотрудник приемной комиссии ______________________________</div>
</section>`;

        const consentPage = `
<section class="page consent">
    <div class="header"><div class="rector">Ректору ФГБОУ ВО<br>«Гжельский государственный университет»<br>Сомову Д.С.</div></div>
    <h1>Согласие<br>на обработку персональных данных</h1>
    <div style="text-align:center; font-size:11pt; margin-bottom:18px; color:#555;">от поступающего${manual.representative?.name ? ' (через законного представителя)' : ''}</div>
    <h3>Сведения о субъекте персональных данных</h3>
    <table class="info">${consentSubjectRows}</table>
    ${manual.representative?.name ? `<h3>Сведения о законном представителе</h3>
    <table class="info">
        <tr><td class="lab">ФИО законного представителя</td><td class="val">${escapeHtml(manual.representative.name)}</td></tr>
        <tr><td class="lab">Документ</td><td class="val">${escapeHtml(manual.representative.doc)}, ${escapeHtml(manual.representative.number)}</td></tr>
        <tr><td class="lab">Кем и когда выдан</td><td class="val">${escapeHtml(manual.representative.issued)}</td></tr>
    </table>` : ''}
    <p>Я, <b>${escapeHtml(manual.representative?.name || app.fullName)}</b>, в соответствии с требованиями ст. 9 Федерального закона от 27.07.2006 № 152-ФЗ «О персональных данных» даю согласие федеральному государственному бюджетному образовательному учреждению высшего образования «Гжельский государственный университет» на обработку персональных данных.</p>
    <div class="purpose"><b>Цель обработки персональных данных:</b> участие в конкурсе и зачисление в число обучающихся, организация образовательного процесса, обеспечение деятельности оператора в соответствии с законодательством Российской Федерации.</div>
    <p><b>Перечень обрабатываемых персональных данных:</b> фамилия, имя, отчество; дата и место рождения; гражданство; реквизиты документа, удостоверяющего личность; СНИЛС; адреса регистрации и фактического проживания; контактный телефон; адрес электронной почты; сведения об образовании; результаты вступительных испытаний и индивидуальные достижения; сведения о льготах и особых правах.</p>
    <p><b>Перечень действий с персональными данными:</b> сбор, систематизация, накопление, хранение, уточнение, использование, передача, обезличивание, блокирование, удаление и уничтожение персональных данных.</p>
    <p>Настоящее согласие действует со дня его подписания и до достижения цели обработки персональных данных или до момента отзыва в письменной форме.</p>
    <p>Подтверждаю достоверность указанных сведений и ознакомление с правами субъекта персональных данных.</p>
    <div class="sign"><span>«____» __________ ${year} г.</span><span>Подпись __________________</span></div>
</section>`;

        const titlePage = `
<section>
    <div class="title-page">
        <p>МИНОБРНАУКИ РОССИИ</p>
        <p>Федеральное государственное бюджетное образовательное учреждение высшего образования</p>
        <p><b>«Гжельский государственный университет»</b></p>
        <p>(ГГУ)</p>
        <p>(${escapeHtml(firstSpec.form || 'очная форма')} обучения)</p>
        <div class="right">
            <p>${escapeHtml(hasBudgetSpec ? 'Бюджет' : 'Внебюджет')}</p>
            <p><u>${escapeHtml(manual.foreignLang || 'не указан')}</u> язык</p>
        </div>
        <p style="padding-top:50px;"><b>ЛИЧНОЕ ДЕЛО № ${escapeHtml(app.entrantId || regNum)}</b></p>
        <p class="name">${escapeHtml(app.lastName)}</p>
        <p class="name">${escapeHtml(app.firstName)}</p>
        <p class="name">${escapeHtml(app.middleName)}</p>
        <div style="margin-top:20px; text-align:center;">
            <p style="text-align:center; margin-bottom:4px;">Среднее профессиональное образование</p>
            <p style="font-size:9pt; margin-bottom:2px; text-align:center;">Профессии / специальности:</p>
            ${specs.map((s, i) => `<p style="margin:3px 0; font-size:10pt; text-align:center;">${specs.length > 1 ? `${i + 1}.&nbsp;` : ''}<b>${escapeHtml(s.program)}</b><span style="font-size:8.5pt; color:#555;"> (${escapeHtml(s.form || '')})</span></p>`).join('')}
        </div>
        <div class="footer">
            <p>Год поступления — ${year}</p>
            <p>пос. Электроизолятор</p>
        </div>
    </div>
</section>`;

        const examHeader = `
            <table border="0" width="100%" cellspacing="0" cellpadding="2" style="border-bottom:3px double #333;">
                <tr><td align="center"><font size="4"><b>ФГБОУ ВО «Гжельский государственный университет»</b></font></td></tr>
            </table>
            <table border="0" width="100%" cellspacing="0" cellpadding="2" style="font-size:12px;">
                <tr><td align="center">РОССИЯ, 140155, г. Электроизолятор, д. 67, тел. +7 (496) 464-76-40</td></tr>
            </table>`;
        const examNum = regNum || app.entrantId || app.id || '';
        const examForm = firstSpec.form || '';
        const examRows = entranceTests.length ? entranceTests : [{ subject: '', display: '', place: '' }];
        const examStudentRows = includeForm => `
            <tr valign="bottom"><td width="27%">Фамилия:</td><td width="73%"><span class="exam-line"><font size="4"><b>${escapeHtml(app.lastName)}</b></font></span></td></tr>
            <tr valign="bottom"><td>Имя:</td><td><span class="exam-line"><font size="4"><b>${escapeHtml(app.firstName)}</b></font></span></td></tr>
            <tr valign="bottom"><td>Отчество:</td><td><span class="exam-line"><font size="4"><b>${escapeHtml(app.middleName)}</b></font></span></td></tr>
            <tr><td>Код:</td><td><span class="exam-line"><b>${escapeHtml(app.entrantId || regNum || '')}</b></span></td></tr>
            ${includeForm ? `<tr valign="top"><td>Форма обучения:</td><td><span class="exam-line"><b>${escapeHtml(examForm)}</b></span></td></tr>` : ''}
            <tr valign="top"><td colspan="2">&nbsp;</td></tr>
            <tr valign="top"><td>Личная подпись:</td><td><span class="exam-line">&nbsp;</span></td></tr>`;
        const examTableRows = showScore => examRows.map((test, i) => `
            <tr valign="top">
                <td align="center">${i + 1}</td>
                <td>${escapeHtml(test.subject || '')}</td>
                <td>Вступительное испытание</td>
                <td align="center">${escapeHtml(test.display || formatEntranceDateTime(test))}</td>
                <td>${escapeHtml(test.place || '')}</td>
                <td align="center">${showScore ? '' : ''}</td>
                <td>&nbsp;</td>
            </tr>`).join('');
        const examSheetBlock = (title, includeForm, showScore) => `
            <table border="0" width="100%" cellpadding="0" cellspacing="0">
                <tr><td valign="top">
                    <p align="center"><font size="4"><b>${escapeHtml(title)}</b></font></p>
                    <table border="0" cellpadding="2" cellspacing="3" width="100%">
                        <tr valign="top">
                            <td width="140px" align="center" class="exam-photo">фото</td>
                            <td><table border="0" cellpadding="2" cellspacing="0"><tbody>${examStudentRows(includeForm)}</tbody></table></td>
                        </tr>
                    </table>
                    <br>
                    <p align="center"><b>${showScore ? 'Лист результатов тестирования' : 'Оценки, полученные на вступительные испытаниях'}</b></p>
                    <table class="exam-border">
                        <tr>
                            <th width="4%">#</th>
                            <th>Дисциплина</th>
                            <th width="22%">Вид испытания</th>
                            <th width="16%">Дата испытания</th>
                            <th width="19%">Место / ФИО преподавателя</th>
                            <th width="10%">${showScore ? 'Оценка, баллов' : 'Оценка'}</th>
                            <th width="10%">Подпись</th>
                        </tr>
                        ${examTableRows(showScore)}
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
        const examSheetPage = `
<section class="page exam-sheet">
    ${examHeader}
    <br>
    <p align="center"><font size="4"><b>Экзаменационный лист № <u>&nbsp;${escapeHtml(examNum || '___')}&nbsp;</u></b></font></p>
    ${examSheetBlock('', true, false)}
</section>
<section class="page exam-sheet">
    ${examHeader}
    <br>
    ${examSheetBlock('Лист результатов тестирования', false, true)}
</section>`;

        const receiptDate = new Date().toLocaleDateString('ru-RU');
        const receiptPage = `
<section class="page receipt">
    <div class="center fs20">
        МИНОБРНАУКИ РОССИИ<br>
        Федеральное государственное бюджетное образовательное учреждение высшего образования<br>
        <b>«Гжельский государственный университет»</b>
    </div>
    <br>
    <div class="center fs20">РАСПИСКА №
        <u>&nbsp;${escapeHtml(regNum || app.entrantId || '')}&nbsp;</u><br>
        <span>о приёме документов</span><br>
        <span class="receipt-hint">(в случае утери расписки следует немедленно сообщить в ГГУ)</span>
    </div>
    <br><br>
    <div class="inline">Получены от гр.&nbsp;</div>
    <div class="inline receipt-name-line">
        <b>${escapeHtml(app.fullName || '')}</b>
    </div>
    <div class="center">
        <span class="receipt-caption">(фамилия, имя, отчество полностью)</span>
    </div>
    <br>
    <div>следующие документы:</div>
    <br>
    <div>1. Заявление о приёме</div>
    <br>
    <div>2. Документ об образовании
        <span class="receipt-underline">${escapeHtml(education.kind || education.section || '')}</span>
        <br>
        выдан
        <span class="receipt-underline">${escapeHtml(eduIssuer || '')}</span>
        &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
        <span class="receipt-underline">
            Серия&nbsp;${escapeHtml(education.series || '')}&nbsp;
            №&nbsp;${escapeHtml(education.number || '')}
        </span>
        &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
        <label>оригинал <input type="radio" name="spo-receipt-edu-doc"></label>
        <label>копия <input type="radio" name="spo-receipt-edu-doc"></label>
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
    <div>9.
        <span class="receipt-extra-line">&nbsp;</span>
    </div>
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
</section>`;

        const caseInventoryPage = `
<section class="page case-inventory">
    <table>
        <tr>
            <td align="center">
                <font size="4">ОПИСЬ ДОКУМЕНТОВ ЛИЧНОГО ДЕЛА</font>
            </td>
        </tr>
        <tr>
            <td align="center">
                <br>
                <span class="case-name-line">
                    <font size="4"><b>${escapeHtml(app.fullName || '')}</b></font>
                </span>
            </td>
        </tr>
        <tr>
            <td align="center">
                <span class="case-caption"><font size="1">(фамилия, имя, отчество полностью)</font></span>
            </td>
        </tr>
        <tr>
            <td valign="top">
                <br>
                <p>1. Заявление о приёме <input type="checkbox"></p>
                <p>2. Контактные данные абитуриента <input type="checkbox"></p>
                <p>3. Письменные работы <input type="checkbox"></p>
                <p>4. Документ об образовании <br>
                    <span class="case-underline">${escapeHtml(education.kind || education.section || '')}</span>&nbsp;&nbsp;&nbsp;&nbsp;
                    <label>оригинал <input type="radio" name="spo-case-edu-doc"></label>
                    <label>копия <input type="radio" name="spo-case-edu-doc"></label>
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
</section>`;

        const contract = manual.contract || {};
        const paidSpecs = specs.filter(s => /плат|договор|внебюдж/i.test(`${s.funding} ${s.status}`));
        const contractSpecs = paidSpecs.length ? paidSpecs : specs;
        const paidSpec = contractSpecs.find(s => contractSpecKey(s) === contract.specKey) || contractSpecs[0] || firstSpec || {};
        const contractNumber = contract.number || '';
        const contractDate = new Date().toLocaleDateString('ru-RU');
        const contractCustomer = contract.customer || app.fullName || '';
        const applicantFullName = app.fullName || [app.lastName, app.firstName, app.middleName].filter(Boolean).join(' ') || contractCustomer;
        const autoContractPrice = tuitionPriceForSpec(paidSpec);
        const contractPriceValue = contract.price || autoContractPrice || '';
        const contractPrice = formatMoney(contractPriceValue) || '________________';
        const contractPriceWords = moneyToWordsRu(contractPriceValue) || '________________';
        const contractYearPriceNumber = Number(String(contractPriceValue || '').replace(/[^\d]/g, ''));
        const contractHalfPriceValue = contractYearPriceNumber ? Math.round(contractYearPriceNumber / 2) : '';
        const contractHalfPrice = formatMoney(contractHalfPriceValue) || '________________';
        const contractHalfPriceWords = moneyToWordsRu(contractHalfPriceValue) || '________________';
        const autoContractTerm = tuitionTermForSpec(paidSpec, education);
        const contractTerm = contract.term || autoContractTerm || '________________';
        const contractYears = contractYearsCeil(contractTerm);
        const contractFullPriceValue = contractYears && contractYearPriceNumber ? contractYearPriceNumber * contractYears : '';
        const contractFullPrice = formatMoney(contractFullPriceValue) || '________________';
        const contractFullPriceWords = moneyToWordsRu(contractFullPriceValue) || '________________';
        const contractFirstPaymentDate = contract.firstPaymentDate || '«____» __________ 20__ г.';
        const contractSecondPaymentDate = contract.secondPaymentDate || '«____» __________ 20__ г.';
        const contractNextFirstPaymentDate = contract.nextFirstPaymentDate || contract.nextPaymentDate || '«____» __________';
        const contractNextSecondPaymentDate = contract.nextSecondPaymentDate || '«____» __________';
        const contractProgram = paidSpec.program || firstSpec.program || '__________________________________________';
        const contractCustomerPassport = contract.customerPassport || applicantContractPassportLine;
        const contractCustomerAddress = contract.customerAddress || manual.regAddress || '';
        const contractCustomerShortName = shortFio(contractCustomer);
        const applicantShortName = shortFio(applicantFullName);
        const contractPage = `
<section class="page paid-contract">
    <div class="contract-title">ДОГОВОР № <u>&nbsp;${escapeHtml(contractNumber || '_____')}&nbsp;</u></div>
    <div class="contract-title">об образовании на обучение по образовательным программам</div>
    <div class="contract-title">среднего профессионального образования</div>
    <div class="contract-place"><span>Пос. Электроизолятор</span><span>«____» __________ 202__ г.</span></div>

    <p>Федеральное государственное бюджетное образовательное учреждение высшего образования «Гжельский государственный университет» (ГГУ), осуществляющее образовательную деятельность по образовательным программам среднего профессионального образования на основании Лицензии 90Л01 N 0008573 (регистрационный номер 1570), выданной 23 июля 2015 г. (с изменениями и дополнениями № Л035-00115-50/00118955) Федеральной службой по надзору в сфере образования и науки бессрочно, и Свидетельства о государственной аккредитации серии 90А01 № 0002894 (регистрационный № 2758 от 21 февраля 2018), выданного Федеральной службой по надзору в сфере образования и науки бессрочно, именуемое в дальнейшем «Исполнитель», в лице ректора Сомова Дениса Сергеевича, действующего на основании Устава,</p>
    <div class="contract-line">${escapeHtml(contractCustomer)}</div>
    <div class="contract-caption">(фамилия, имя, отчество)</div>
    <p>именуемая(ый) в дальнейшем «Заказчик», и</p>
    <div class="contract-line">${escapeHtml(applicantFullName)}</div>
    <div class="contract-caption">(фамилия, имя, отчество (при наличии) лица, зачисляемого на обучение)</div>
    <p>именуемый в дальнейшем «Обучающийся», совместно именуемые Стороны, заключили настоящий Договор (далее - Договор) о нижеследующем:</p>

    <h3>I. Предмет Договора</h3>
    <p>1.1. Исполнитель обязуется предоставить образовательную услугу, а Обучающийся/Заказчик (ненужное вычеркнуть) обязуется оплатить обучение по образовательной программе</p>
    <div class="contract-line">${escapeHtml(contractProgram)}</div>
    <div class="contract-caption">(наименование образовательной программы среднего профессионального образования)</div>
    <div class="contract-line">${escapeHtml([paidSpec.form, paidSpec.code, paidSpec.specialty].filter(Boolean).join(', '))}</div>
    <div class="contract-caption">(форма обучения, код, наименование профессии, специальности)</div>
    <p>в пределах федерального государственного образовательного стандарта или образовательного стандарта в соответствии с учебными планами, в том числе индивидуальными, и образовательными программами Исполнителя.</p>
    <p>1.2. Срок освоения образовательной программы (продолжительность обучения) на момент подписания Договора составляет <u>&nbsp;${escapeHtml(contractTerm)}&nbsp;</u>. Срок обучения по индивидуальному учебному плану, в том числе ускоренному обучению, составляет __________________________.</p>
    <p>1.3. После освоения Обучающимся образовательной программы и успешного прохождения государственной итоговой аттестации ему выдается диплом о среднем профессиональном образовании по форме, утвержденной Министерством образования и науки Российской Федерации.</p>
    <p>1.4. Обучающемуся, не прошедшему итоговой аттестации или получившему на итоговой аттестации неудовлетворительные результаты, а также Обучающемуся, освоившему часть образовательной программы и (или) отчисленному из ГГУ, выдается справка об обучении или о периоде обучения по образцу, самостоятельно устанавливаемому Исполнителем.</p>

    <h3>II. Взаимодействие сторон</h3>
    <p>2.1. Исполнитель вправе самостоятельно осуществлять образовательный процесс, выбирать системы оценок, формы, порядок и периодичность промежуточной аттестации Обучающегося.</p>
    <p>2.1.2. Применять электронное обучение, дистанционные образовательные технологии при реализации образовательной программы в порядке, установленном законодательством Российской Федерации.</p>
    <p>2.1.3. Применять к Обучающемуся меры поощрения и меры дисциплинарного взыскания в соответствии с законодательством Российской Федерации, учредительными документами Исполнителя, настоящим Договором и локальными нормативными актами Исполнителя.</p>
    <p>2.2. Заказчик вправе получать информацию от Исполнителя по вопросам организации и обеспечения надлежащего предоставления услуг, предусмотренных разделом I настоящего Договора.</p>
    <p>2.3. Обучающемуся предоставляются академические права в соответствии с частью 1 статьи 34 Федерального закона от 29 декабря 2012 г. N 273-ФЗ «Об образовании в Российской Федерации». Обучающийся также вправе получать информацию от Исполнителя, пользоваться имуществом Исполнителя, принимать участие в мероприятиях и получать полную и достоверную информацию об оценке своих знаний, умений, навыков и компетенций.</p>
    <p>2.4. Исполнитель обязан зачислить Обучающегося, выполнившего установленные законодательством Российской Федерации, учредительными документами, локальными нормативными актами Исполнителя условия приема, в качестве студента.</p>
    <p>2.4.2. Исполнитель обязан довести до Заказчика информацию, содержащую сведения о предоставлении платных образовательных услуг, в порядке и объеме, предусмотренных законодательством Российской Федерации.</p>
    <p>2.4.3. Исполнитель обязан организовать и обеспечить надлежащее предоставление образовательных услуг, предусмотренных разделом I настоящего Договора, в соответствии с федеральным государственным образовательным стандартом, учебным планом, календарным учебным графиком и расписанием занятий Исполнителя.</p>
    <p>2.4.4. Исполнитель обязан обеспечить Обучающемуся условия освоения выбранной образовательной программы, уважение человеческого достоинства, защиту от всех форм физического и психического насилия, оскорбления личности, охрану жизни и здоровья.</p>
    <p>2.5. Заказчик и (или) Обучающийся обязан(-ы) своевременно вносить плату за предоставляемые образовательные услуги в размере и порядке, определенных настоящим Договором, соблюдать требования учредительных документов, правил внутреннего распорядка и иных локальных нормативных актов Исполнителя.</p>

    <h3>III. Стоимость образовательных услуг, сроки и порядок их оплаты</h3>
    <p>3.1. Полная стоимость образовательных услуг за весь период обучения Обучающегося составляет <u>&nbsp;${escapeHtml(contractFullPrice)}&nbsp;</u> рублей (${escapeHtml(contractFullPriceWords)}). В соответствии со ст.149 НК РФ стоимость услуг НДС не облагается.</p>
    <p>3.2. Стоимость образовательных услуг за первый год обучения составляет <u>&nbsp;${escapeHtml(contractPrice)}&nbsp;</u> рублей (${escapeHtml(contractPriceWords)}).</p>
    <p>Оплата производится в следующем порядке:</p>
    <p>- за первый год обучения <u>&nbsp;${escapeHtml(contractHalfPrice)}&nbsp;</u> (${escapeHtml(contractHalfPriceWords)}) рублей до <input class="contract-date-input contract-date-first" value="${escapeHtml(contractFirstPaymentDate)}" aria-label="Первый срок оплаты за первый год обучения">, и <u>&nbsp;${escapeHtml(contractHalfPrice)}&nbsp;</u> (${escapeHtml(contractHalfPriceWords)}) рублей до <input class="contract-date-input contract-date-second" value="${escapeHtml(contractSecondPaymentDate)}" aria-label="Второй срок оплаты за первый год обучения">;</p>
    <p>- за второй и последующие учебные годы оплата производится до <input class="contract-date-input contract-date-next-first" value="${escapeHtml(contractNextFirstPaymentDate)}" aria-label="Первый срок оплаты за второй и последующие годы"> и до <input class="contract-date-input contract-date-next-second" value="${escapeHtml(contractNextSecondPaymentDate)}" aria-label="Второй срок оплаты за второй и последующие годы">, в размере половины стоимости обучения в текущем учебном году.</p>
    <p>Заказчик самостоятельно (по заявлению) выбирает форму оплаты за обучение (наличную - в кассу или безналичную - через банк).</p>
    <p>3.3. Приказ о зачислении Обучающегося издается после поступления оплаты за обучение на расчетный счет или в кассу Исполнителя.</p>
    <p>3.4. Увеличение стоимости платных образовательных услуг после заключения Договора не допускается, за исключением увеличения стоимости указанных услуг с учетом уровня инфляции, предусмотренного основными характеристиками федерального бюджета на очередной финансовый год и плановый период.</p>
    <p>3.5. В целях упорядочения взаиморасчетов Стороны принимают, что продолжительность одного семестра составляет 5 месяцев, учебный год состоит из 2 (двух) семестров и не включает период летних каникул.</p>
    <p>3.6. В случае просрочки уплаты платежей по настоящему Договору Заказчик выплачивает Исполнителю пеню в размере 0,1% от суммы просроченного платежа за каждый день просрочки.</p>
    <p>3.7. При досрочном расторжении или прекращении образовательных отношений по Договору Заказчику/Обучающемуся на основании его заявления возвращаются денежные средства, внесенные им досрочно за обучение, в порядке, установленном локальным нормативным актом Исполнителя.</p>
    <p>3.8. Исполнитель не производит возврат денежных средств за услуги, оказанные до даты отчисления Обучающегося. Образовательная услуга считается оказанной также в том случае, если вследствие действий (бездействия) самого Обучающегося он ею не воспользовался.</p>

    <h3>IV. Порядок изменения и расторжения Договора</h3>
    <p>4.1. Условия, на которых заключен настоящий Договор, могут быть изменены по соглашению Сторон или в соответствии с законодательством Российской Федерации.</p>
    <p>4.2. Настоящий Договор может быть расторгнут по соглашению Сторон.</p>
    <p>4.3. Настоящий Договор может быть расторгнут по инициативе Исполнителя в одностороннем порядке в случаях, предусмотренных пунктом 22 Правил оказания платных образовательных услуг, утвержденных постановлением Правительства Российской Федерации от 15 сентября 2020 г. № 1441: применение к обучающемуся дисциплинарного взыскания в виде отчисления; невыполнение обучающимся обязанностей по добросовестному освоению образовательной программы и выполнению учебного плана; установление нарушения порядка приема, повлекшего по вине обучающегося его незаконное зачисление; просрочка оплаты стоимости платных образовательных услуг; невозможность надлежащего исполнения обязательств вследствие действий (бездействия) Обучающегося.</p>
    <p>4.4. Действие Договора прекращается досрочно по инициативе Обучающегося или Заказчика, по инициативе Исполнителя, по обстоятельствам, не зависящим от воли Сторон, в том числе в случае ликвидации Исполнителя.</p>
    <p>4.5. Исполнитель вправе отказаться от исполнения Договора в одностороннем порядке при наличии оснований, предусмотренных законодательством Российской Федерации.</p>
    <p>4.6. Обучающийся вправе отказаться от исполнения настоящего Договора при условии оплаты Исполнителю фактически понесенных расходов.</p>

    <h3>V. Ответственность Исполнителя, Заказчика и Обучающегося и порядок рассмотрения споров</h3>
    <p>5.1. За неисполнение или ненадлежащее исполнение обязательств по Договору Стороны несут ответственность, предусмотренную законодательством Российской Федерации и настоящим Договором.</p>
    <p>5.2. При обнаружении недостатка образовательной услуги, в том числе оказания ее не в полном объеме, Заказчик вправе по своему выбору потребовать безвозмездного оказания образовательной услуги, соразмерного уменьшения стоимости оказанной образовательной услуги либо возмещения понесенных им расходов по устранению недостатков оказанной образовательной услуги своими силами или третьими лицами.</p>
    <p>5.3. Заказчик вправе отказаться от исполнения Договора и потребовать полного возмещения убытков, если в семидневный срок недостатки образовательной услуги не устранены Исполнителем, а также если обнаружен существенный недостаток оказанной образовательной услуги или иные существенные отступления от условий Договора.</p>
    <p>5.4. Если Исполнитель нарушил сроки оказания образовательной услуги либо если во время оказания образовательной услуги стало очевидным, что она не будет оказана в срок, Заказчик вправе назначить Исполнителю новый срок, поручить оказание услуги третьим лицам за разумную цену и потребовать возмещения расходов, потребовать уменьшения стоимости образовательной услуги либо расторгнуть Договор.</p>
    <p>5.5. Все споры по настоящему Договору разрешаются Сторонами путем переговоров, а при невозможности достижения согласия - в судебном порядке по месту нахождения Исполнителя в Московской области.</p>
    <p>5.6. Местом исполнения настоящего Договора является место нахождения Исполнителя независимо от места нахождения Заказчика/Обучающегося.</p>

    <h3>VI. Срок действия Договора</h3>
    <p>Настоящий Договор вступает в силу со дня его заключения Сторонами и действует до полного исполнения Сторонами обязательств.</p>

    <h3>VII. Заключительные положения</h3>
    <p>7.1. Исполнитель вправе снизить стоимость платных образовательных услуг по Договору с учетом покрытия недостающей стоимости платных образовательных услуг за счет собственных средств Исполнителя.</p>
    <p>7.2. Сведения, указанные в настоящем Договоре, соответствуют информации, размещенной на официальном сайте Исполнителя в сети Интернет на дату заключения настоящего Договора.</p>
    <p>7.3. Под периодом предоставления образовательной услуги понимается промежуток времени с даты издания приказа о зачислении Обучающегося до даты издания приказа об окончании обучения или отчислении Обучающегося из образовательной организации.</p>
    <p>7.4. Настоящий Договор составлен в 2 экземплярах, по одному для каждой из Сторон. Все экземпляры имеют одинаковую юридическую силу.</p>
    <p>7.5. Изменения и дополнения настоящего Договора оформляются дополнительными соглашениями к Договору.</p>

    <h3>VIII. Адреса и реквизиты Сторон</h3>
    <div class="contract-parties">
        <div>
            <b>Исполнитель</b><br>
            ГГУ<br>
            Адрес: 140155 Московская область, Раменский м.о., пос. Электроизолятор, д. 67<br>
            Банковские реквизиты:<br>
            Управление Федерального казначейства по Нижегородской области (Гжельский государственный университет л/с 20486X86950) (Х - на англ. языке)<br>
            ИНН/КПП 5040036468/504001001<br>
            Единый казначейский счет: 40102810745370000024<br>
            Казначейский счет: 03214643000000013234<br>
            ОКТМО: 46568000<br>
            Наименование банка: ОКЦ № 1 ВВГУ Банка России//УФК по Нижегородской области, г. Нижний Новгород<br>
            БИК ТОФК: 012202102<br>
            КБК: 00000000000000000130<br>
            Email: artgzhel@yandex.ru<br>
            Тел./факс: 8-496-464-76-40<br>
            Ректор
        </div>
        <div>
            <b>Заказчик</b><br>
            ФИО: ${escapeHtml(contractCustomer)}<br>
            Адрес регистрации: ${escapeHtml(contractCustomerAddress)}<br>
            Паспортные данные: ${escapeHtml(contractCustomerPassport)}<br>
            Тел.: __________________
        </div>
        <div>
            <b>Обучающийся</b><br>
            ФИО: ${escapeHtml(applicantFullName)}<br>
            Адрес регистрации: ${escapeHtml(manual.regAddress || '')}<br>
            Паспортные данные: ${escapeHtml(applicantContractPassportLine)}<br>
            Тел.: __________________
        </div>
    </div>
    <div class="contract-clear"></div>
    <table class="contract-bottom-signs">
        <tr>
            <td>Ректор</td>
            <td>Заказчик</td>
            <td>Обучающийся</td>
        </tr>
        <tr>
            <td>________________</td>
            <td>________________</td>
            <td>________________</td>
        </tr>
        <tr class="contract-sign-names">
            <td>Д.С. Сомов</td>
            <td>${escapeHtml(contractCustomerShortName)}</td>
            <td>${escapeHtml(applicantShortName)}</td>
        </tr>
    </table>
    <p class="contract-stamp">М.П.</p>
    <table class="contract-approve">
        <tr><td width="30%">Согласовано:</td><td width="70%"></td></tr>
        <tr><td>Директор колледжа</td><td>______________________/______________________</td></tr>
        <tr><td>Бухгалтер</td><td>______________________/______________________</td></tr>
    </table>
    <div class="contract-executor">Исполнитель ______________________/______________________</div>
    <div class="contract-executor-caption">(подпись) &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; (ФИО)</div>
</section>`;

        const bodyHtml = docType === 'application'
            ? applicationPage
            : docType === 'consent'
                ? consentPage
                : docType === 'title'
                    ? titlePage
                    : docType === 'receipt'
                        ? receiptPage
                        : docType === 'examSheet'
                            ? examSheetPage
                            : docType === 'caseInventory'
                                ? caseInventoryPage
                                : docType === 'paidContract'
                                    ? contractPage
                                    : `${applicationPage}${consentPage}${titlePage}${receiptPage}${caseInventoryPage}`;

        const docStorageKey = storageKey(app.id || appIdFromLocation());
        return `<!doctype html><html lang="ru"><head><meta charset="UTF-8">
<title>Комплект СПО — ${escapeHtml(app.fullName)}</title>
<style>
@page { size: A4; margin: 14mm; }
body { width: 175mm; margin: 10px auto; font-family: Arial, sans-serif; color: #000; background:#fff; font-size: 12pt; }
h1.title { text-align: center; font-size: 13pt; font-weight: bold; margin: 14px 0 8px; }
h2 { text-align: center; font-size: 13pt; margin: 10px 0; }
h3 { font-size: 11pt; margin: 12px 0 6px; }
.page { padding-top: 8mm; }
.page:first-of-type { padding-top: 0; }
section + section { page-break-before: always; break-before: page; }
@media screen { section + section { margin-top: 18mm; } }
.reg-num { font-size: 10pt; font-weight: bold; }
.intro { font-size: 11pt; font-weight: bold; margin-bottom: 6px; }
.t { width: 175mm; border-collapse: collapse; margin: 8px 0; }
.t.bordered td, .t.bordered th { border: 1px solid #000; padding: 3px 5px; vertical-align: middle; }
.t.dashed td { border: 1px dashed #000; padding: 4px 6px; }
.div1 { font-size: 7pt; font-weight: bold; }
.div2 { font-size: 9pt; font-weight: bold; }
.div3 { font-size: 7pt; font-weight: lighter; }
.div4 { font-size: 9pt; font-weight: lighter; font-style: italic; }
.div5 { font-size: 10pt; font-weight: lighter; }
.original-title { text-align:center; font-size:12pt; font-weight:bold; margin-top:8px; }
.admission-table td { font-size: 9pt; }
.rotate-priority { text-align:center; vertical-align:middle; }
.rotate-priority div { transform: rotate(270deg); white-space: nowrap; font-size:11px; font-weight:bold; }
.select-line { display:inline-block; min-width:45mm; border-bottom:1px solid #000; }
.original-ack td:nth-child(2) { text-align:center; vertical-align:middle; }
.text-small { font-size: 10pt; }
.text-tiny { font-size: 8pt; color: #555; }
.signature { margin-top: 16px; font-size: 11pt; }
.consent { font-family: 'Times New Roman', serif; font-size: 12pt; line-height: 1.35; }
.consent h1 { text-align:center; font-size:14pt; text-transform:uppercase; margin: 22px 0 8px; }
.consent .header { text-align:right; margin-bottom: 20px; font-size: 11pt; }
.consent .header .rector { width: 70mm; margin-left: auto; }
.consent .info { width:100%; border-collapse:collapse; margin-bottom:8px; font-size:11pt; }
.consent .info td { border:1px solid #000; padding:4px 8px; vertical-align:top; }
.consent .info .lab { width:38%; font-weight:600; background:#f4f4f4; }
.consent p { text-align: justify; margin: 8px 0; }
.consent .purpose { margin: 8px 0; padding: 8px 12px; background:#f9f9f9; border-left:3px solid #636C8D; }
.sign { margin-top: 22px; display: flex; justify-content: space-between; gap: 24px; }
.title-page { font-family:'Times New Roman', serif; border:1px solid #000; padding:20px; text-align:center; min-height:250mm; display:flex; flex-direction:column; }
.title-page .name { text-transform:uppercase; text-decoration:underline; font-size:28pt; font-weight:bold; margin:4px auto; }
.title-page .right { text-align:right; padding-right:40px; }
.title-page .footer { margin-top:auto; padding-top:30px; }
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
.exam-sheet { font-family: Arial, sans-serif; font-size:12pt; width:180mm; margin:0 auto; }
.exam-line { display:inline-block; width:100%; border-bottom:1px solid #000; }
.exam-photo { border:1px dashed #ccc; height:180px; vertical-align:middle; color:#aaa; font-size:9pt; }
.exam-border { width:100%; border-collapse:collapse; }
.exam-border th, .exam-border td { border:1px solid #333; padding:4px 6px; font-size:10pt; }
.case-inventory { width:197mm; min-height:210mm; padding:5mm 5mm 5mm 10mm; margin:0 auto; font-family:'Times New Roman', serif; }
.case-inventory table { font-size:14pt; font-family:'Times New Roman', serif; }
.case-inventory p { margin: 10px 0; }
.case-name-line { display:inline-block; width:100%; border-bottom:1px solid #000; }
.case-caption { border-bottom:1px solid #000; }
.case-underline { border-bottom:1px solid #000; padding:0 8px; }
.case-empty-line { display:block; margin-left:20px; border-bottom:1px solid #000; min-height:18px; }
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
.contract-clear { clear:both; height:10px; }
.contract-bottom-signs { width:175mm; border-collapse:collapse; margin:16px 0 6px; font-size:11pt; }
.contract-bottom-signs td { width:33.33%; padding:5px 6px; vertical-align:bottom; text-align:left; }
.contract-bottom-signs .contract-sign-names td { font-size:10pt; padding-top:0; }
.contract-approve { width:175mm; border-collapse:collapse; font-size:11pt; }
.contract-approve td { padding:4px 6px; }
.contract-stamp { text-indent:0 !important; margin:8px 0 !important; }
.contract-executor { width:100%; margin-top:15px; font-size:14px; }
.contract-executor-caption { text-indent:70mm; font-size:14px; }
.no-print { margin: 18px auto; display: flex; gap: 10px; justify-content: center; }
.no-print button { padding: 9px 18px; border: 0; border-radius: 7px; background: #636C8D; color: #fff; cursor: pointer; }
@media print { .no-print { display: none; } body { margin: 0; width: 100%; } .contract-date-input { background:transparent; outline:0; } }
</style></head><body>
<div class="no-print"><button onclick="window.print()">Распечатать</button><button onclick="window.close()">Закрыть</button></div>
${bodyHtml}
<script>
(() => {
    const storageKey = ${JSON.stringify(docStorageKey)};
    const saveContractDate = (field, value) => {
        try {
            const data = JSON.parse(localStorage.getItem(storageKey) || '{}');
            data.manual = data.manual || {};
            data.manual.contract = data.manual.contract || {};
            data.manual.contract[field] = value.trim();
            data.updatedAt = new Date().toISOString();
            localStorage.setItem(storageKey, JSON.stringify(data));
        } catch {}
    };
    document.querySelector('.contract-date-first')?.addEventListener('input', e => saveContractDate('firstPaymentDate', e.target.value));
    document.querySelector('.contract-date-second')?.addEventListener('input', e => saveContractDate('secondPaymentDate', e.target.value));
    document.querySelector('.contract-date-next-first')?.addEventListener('input', e => saveContractDate('nextFirstPaymentDate', e.target.value));
    document.querySelector('.contract-date-next-second')?.addEventListener('input', e => saveContractDate('nextSecondPaymentDate', e.target.value));
})();
</script>
</body></html>`;
    }

    function debugHtml(data) {
        return `<!doctype html><meta charset="UTF-8"><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
    }

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

    function init() {
        setTimeout(() => {
            const data = collectCurrentPage();
            addPanel();
            renderPanel(data);
        }, 600);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
