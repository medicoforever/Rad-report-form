// A batch type used for report generation
interface ReportBatch {
    id: string;
    name: string;
    findings: string[] | null;
}

const getEmbeddedScript = () => `
// Embedded script for standalone HTML report functionality
document.addEventListener('DOMContentLoaded', () => {
    // --- STATE ---
    let multiSelectMode = false;
    const selections = {}; // { [batchId]: Set<number> }
    let notificationTimeout = null;

    // --- DOM ELEMENTS ---
    const notificationEl = document.getElementById('notification');
    const multiSelectBanner = document.getElementById('multi-select-banner');
    const multiSelectToggle = document.getElementById('multi-select-toggle');
    
    // --- HELPER FUNCTIONS ---
    const showNotification = (text) => {
        if (notificationTimeout) clearTimeout(notificationTimeout);
        notificationEl.textContent = text;
        notificationEl.classList.remove('opacity-0');
        notificationTimeout = setTimeout(() => {
            notificationEl.classList.add('opacity-0');
        }, 2000);
    };

    const copyToClipboard = async (plainText, htmlText) => {
        try {
            // Using ClipboardItem API for rich text, which is supported in most modern browsers except Firefox.
            if (window.ClipboardItem) {
                const htmlBlob = new Blob([htmlText], { type: 'text/html' });
                const textBlob = new Blob([plainText], { type: 'text/plain' });
                const clipboardItem = new ClipboardItem({
                    'text/html': htmlBlob,
                    'text/plain': textBlob,
                });
                await navigator.clipboard.write([clipboardItem]);
                return true;
            }
            throw new Error('ClipboardItem API not available.');
        } catch (err) {
            console.warn('Rich text copy failed, falling back to plain text.', err);
            try {
                await navigator.clipboard.writeText(plainText);
                return true;
            } catch (fallbackErr) {
                console.error('Plain text copy failed as well.', fallbackErr);
                return false;
            }
        }
    };

    const getFindingParts = (findingEl) => {
        const rawFinding = decodeURIComponent(findingEl.dataset.findingRaw || '');
        const parts = rawFinding.split('###');
        const isStructured = parts.length > 1;
        return { rawFinding, parts, isStructured };
    };

    const updateFindingSelection = (batchId, index, shouldSelect) => {
        if (!selections[batchId]) {
            selections[batchId] = new Set();
        }
        const findingEl = document.querySelector(\`[data-batch-id="\${batchId}"][data-finding-index="\${index}"]\`);
        const checkboxEl = findingEl.querySelector('[role="checkbox"] > div');
        
        if (shouldSelect) {
            selections[batchId].add(index);
            findingEl.classList.add('selected');
            checkboxEl.classList.add('bg-blue-600', 'border-blue-600');
            checkboxEl.classList.remove('border-slate-400', 'bg-white');
        } else {
            selections[batchId].delete(index);
            findingEl.classList.remove('selected');
            checkboxEl.classList.remove('bg-blue-600', 'border-blue-600');
            checkboxEl.classList.add('border-slate-400', 'bg-white');
        }
    };

    const copyBatchSelection = async (batchId) => {
        const selection = selections[batchId];
        if (!selection || selection.size === 0) {
            showNotification('Selection cleared.');
            return;
        }

        const sortedIndices = Array.from(selection).sort((a, b) => a - b);
        
        let plainTexts = [];
        let htmlTexts = [];

        sortedIndices.forEach(i => {
            const findingEl = document.querySelector(\`[data-batch-id="\${batchId}"][data-finding-index="\${i}"]\`);
            const { parts, isStructured } = getFindingParts(findingEl);
            if (isStructured) {
                plainTexts.push(parts.join('\\n'));
                htmlTexts.push(\`<p><strong>\${parts[0]}</strong></p>\${parts.slice(1).map(p => \`<p><strong>\${p}</strong></p>\`).join('')}\`);
            } else {
                plainTexts.push(parts[0]);
                htmlTexts.push(\`<p><strong>\${parts[0]}</strong></p>\`);
            }
        });
        
        const plainText = plainTexts.join('\\n');
        const htmlText = htmlTexts.join('');

        const success = await copyToClipboard(plainText, htmlText);
        const notificationText = success
            ? \`Copied \${selection.size} finding\${selection.size > 1 ? 's' : ''}!\`
            : 'Copy failed!';
        showNotification(notificationText);
    };

    const toggleMultiSelectMode = (enabled) => {
        multiSelectMode = enabled;
        if (enabled) {
            multiSelectBanner.classList.remove('hidden');
            multiSelectBanner.classList.add('flex');
            if (multiSelectToggle) multiSelectToggle.checked = true;
        } else {
            multiSelectBanner.classList.add('hidden');
            multiSelectBanner.classList.remove('flex');
            if (multiSelectToggle) multiSelectToggle.checked = false;
            // Clear all selections
            Object.keys(selections).forEach(batchId => {
                if(selections[batchId]){
                    selections[batchId].forEach(index => {
                        updateFindingSelection(batchId, index, false);
                    });
                    selections[batchId].clear();
                }
            });
        }
    };

    // --- EDITING LOGIC ---
    let currentEditing = null; // { batchId, index, originalHTML }
    
    const cancelAllEdits = () => {
        if (!currentEditing) return;
        const { batchId, index, originalHTML } = currentEditing;
        const findingEl = document.querySelector(\`[data-batch-id="\${batchId}"][data-finding-index="\${index}"]\`);
        if (findingEl) {
            findingEl.innerHTML = originalHTML;
            addFindingEventListeners(findingEl, batchId, index);
        }
        currentEditing = null;
    }

    const startEditing = (findingEl, batchId, index) => {
        cancelAllEdits(); // Cancel any other ongoing edits

        const originalHTML = findingEl.innerHTML;
        currentEditing = { batchId, index, originalHTML: originalHTML };
        
        const { parts } = getFindingParts(findingEl);
        const textForEditing = parts.join('\\n');

        findingEl.innerHTML = \`
            <div class="flex flex-col gap-2">
                <textarea class="w-full p-2 border rounded-md font-semibold text-slate-700 focus:ring-2 focus:ring-blue-500 focus:outline-none" rows="3"></textarea>
                <div class="flex justify-end gap-2">
                    <button class="edit-cancel text-sm font-semibold py-1 px-3 rounded-lg bg-slate-200 text-slate-700 hover:bg-slate-300">Cancel</button>
                    <button class="edit-save text-sm font-semibold py-1 px-3 rounded-lg bg-blue-600 text-white hover:bg-blue-700">Save</button>
                </div>
            </div>
        \`;
        const textarea = findingEl.querySelector('textarea');
        textarea.value = textForEditing;
        textarea.rows = Math.max(3, textForEditing.split('\\n').length);
        textarea.focus();

        findingEl.querySelector('.edit-save').addEventListener('click', () => {
            const newText = findingEl.querySelector('textarea').value;
            const newRawFinding = newText.split('\\n').filter(Boolean).join('###');
            
            findingEl.innerHTML = originalHTML; // Restore structure
            findingEl.dataset.findingRaw = encodeURIComponent(newRawFinding);
            
            // Update display text
            const newParts = newRawFinding.split('###');
            const textEl = findingEl.querySelector('.finding-text');
            if (newParts.length > 1) {
              textEl.innerHTML = \`<span>\${newParts[0]}</span>\${newParts.slice(1).map(p => \`<span class="block font-semibold">\${p}</span>\`).join('')}\`;
            } else {
              textEl.innerHTML = newRawFinding;
            }
            
            addFindingEventListeners(findingEl, batchId, index);
            currentEditing = null;
        });

        findingEl.querySelector('.edit-cancel').addEventListener('click', () => {
            findingEl.innerHTML = originalHTML;
            addFindingEventListeners(findingEl, batchId, index);
            currentEditing = null;
        });
    };
    
    // --- EVENT LISTENER ATTACHMENT ---
    const addFindingEventListeners = (findingEl, batchId, index) => {
        const textEl = findingEl.querySelector('.finding-text');
        const selectionHandle = findingEl.querySelector('.selection-handle');
        const editBtn = findingEl.querySelector('.edit-btn');
        
        // Single copy
        textEl.addEventListener('click', async () => {
            if (multiSelectMode || currentEditing) return;
            
            const { parts, isStructured } = getFindingParts(findingEl);
            let plainText;
            let htmlText;

            if (isStructured) {
                plainText = parts.join('\\n');
                htmlText = \`<p><strong>\${parts[0]}</strong></p>\${parts.slice(1).map(p => \`<p><strong>\${p}</strong></p>\`).join('')}\`;
            } else {
                plainText = parts[0];
                htmlText = \`<p><strong>\${parts[0]}</strong></p>\`;
            }
            
            const success = await copyToClipboard(plainText, htmlText);
            
            if (success) {
                updateFindingSelection(batchId, index, true);
                setTimeout(() => updateFindingSelection(batchId, index, false), 500);
                showNotification('Copied!');
            } else {
                showNotification('Copy failed!');
            }
        });

        // Multi-select toggle
        selectionHandle.addEventListener('click', () => {
            if (currentEditing) return;
            if (!multiSelectMode) {
                toggleMultiSelectMode(true);
            }
            const selection = selections[batchId] || new Set();
            const isSelected = selection.has(index);
            updateFindingSelection(batchId, index, !isSelected);
            copyBatchSelection(batchId);
        });

        // Edit
        if (editBtn) {
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                startEditing(findingEl, batchId, index);
            });
        }
    }

    // --- INITIALIZATION ---
    if (multiSelectToggle) {
        multiSelectToggle.addEventListener('change', () => toggleMultiSelectMode(multiSelectToggle.checked));
    }
    
    document.querySelectorAll('.finding-item').forEach(findingEl => {
        const batchId = findingEl.dataset.batchId;
        const index = parseInt(findingEl.dataset.findingIndex, 10);
        addFindingEventListeners(findingEl, batchId, index);
    });

    document.querySelectorAll('.copy-all-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const batchId = e.currentTarget.dataset.batchId;
            const findingElements = document.querySelectorAll(\`[data-batch-id="\${batchId}"]\`);
            
            if (findingElements.length === 0) return;

            let plainTexts = [];
            let htmlTexts = [];

            findingElements.forEach(el => {
                const { parts, isStructured } = getFindingParts(el);
                if (isStructured) {
                    plainTexts.push(parts.join('\\n'));
                    htmlTexts.push(\`<p><strong>\${parts[0]}</strong></p>\${parts.slice(1).map(p => \`<p><strong>\${p}</strong></p>\`).join('')}\`);
                } else {
                    plainTexts.push(parts[0]);
                    htmlTexts.push(\`<p><strong>\${parts[0]}</strong></p>\`);
                }
            });

            const plainText = plainTexts.join('\\n');
            const htmlText = htmlTexts.join('');
            const success = await copyToClipboard(plainText, htmlText);

            if (success) {
                e.currentTarget.textContent = 'Copied!';
                setTimeout(() => { e.currentTarget.textContent = 'Copy All'; }, 2000);
            }
        });
    });

    const copyAllTranscriptsBtn = document.getElementById('copy-all-transcripts');
    if (copyAllTranscriptsBtn) {
        copyAllTranscriptsBtn.addEventListener('click', async () => {
            const batches = Array.from(document.querySelectorAll('[data-batch-container-id]'));
            let plainText = '';
            let htmlText = '';

            batches.forEach(batchEl => {
                const batchId = batchEl.dataset.batchContainerId;
                const batchName = batchEl.querySelector('h3').textContent;
                const findingElements = document.querySelectorAll(\`[data-batch-id="\${batchId}"]\`);
                
                if (findingElements.length > 0) {
                    let batchPlainText = [];
                    let batchHtmlText = '';

                    findingElements.forEach(el => {
                        const { parts, isStructured } = getFindingParts(el);
                        if (isStructured) {
                            batchPlainText.push(parts.join('\\n'));
                            batchHtmlText += \`<p><strong>\${parts[0]}</strong></p>\${parts.slice(1).map(p => \`<p><strong>\${p}</strong></p>\`).join('')}\`;
                        } else {
                            batchPlainText.push(parts[0]);
                            batchHtmlText += \`<p><strong>\${parts[0]}</strong></p>\`;
                        }
                    });

                    plainText += \`[\${batchName}]\\n\${batchPlainText.join('\\n')}\\n\\n\`;
                    htmlText += \`<h3>\${batchName}</h3>\` + batchHtmlText;
                }
            });

            if (plainText.length === 0) return;

            const success = await copyToClipboard(plainText.trim(), htmlText.trim());
            if (success) {
                copyAllTranscriptsBtn.textContent = 'Copied!';
                setTimeout(() => { copyAllTranscriptsBtn.textContent = 'Copy All Transcripts'; }, 2000);
            }
        });
    }
});
`;

const getHTMLTemplate = (title: string, content: string): string => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
      .finding-item.selected {
        background-color: #DBEAFE; /* bg-blue-100 */
        border-left-color: #2563EB; /* border-blue-600 */
        box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
      }
      .finding-item .selection-handle div {
        transition: all 0.2s ease-in-out;
      }
    </style>
</head>
<body class="bg-slate-100 font-sans">
    <div class="max-w-3xl mx-auto p-4 sm:p-8">
        <header class="text-center mb-8">
            <h1 class="text-4xl font-bold text-slate-800">${title}</h1>
            <p class="text-slate-600 mt-2">This is a standalone report. AI and audio features are not available.</p>
        </header>
        <main class="bg-white rounded-2xl shadow-xl p-4 sm:p-8">
            ${content}
        </main>
        <footer class="text-center mt-8 text-sm text-slate-500">
          <p>Generated from Radiology Dictation Corrector</p>
        </footer>
    </div>
    
    <div id="notification" class="fixed bottom-4 right-4 bg-slate-800 text-white text-sm font-bold py-2 px-4 rounded-lg shadow-lg z-50 transition-all duration-300 ease-in-out opacity-0" role="alert"></div>

    <div id="multi-select-banner" class="hidden fixed bottom-5 left-1/2 -translate-x-1/2 z-40 bg-slate-800 text-white rounded-full shadow-lg items-center gap-4 px-5 py-2 transition-all duration-300 ease-in-out">
        <p class="text-sm font-semibold">Multi-select Mode</p>
        <label for="multi-select-toggle" class="flex items-center cursor-pointer">
            <span class="mr-2 text-sm font-medium text-slate-300">OFF</span>
            <div class="relative">
                <input 
                    type="checkbox" 
                    id="multi-select-toggle" 
                    class="sr-only peer"
                />
                <div class="w-12 h-6 bg-slate-600 rounded-full peer-checked:bg-blue-600"></div>
                <div class="absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform peer-checked:translate-x-6"></div>
            </div>
            <span class="ml-2 text-sm font-medium">ON</span>
        </label>
    </div>

    <script type="text/javascript">
      ${getEmbeddedScript()}
    </script>
</body>
</html>
`;

const renderFindingsList = (findings: string[], batchId: string): string => {
    if (!findings || findings.length === 0) {
        return '<p class="text-slate-500">No findings were transcribed.</p>';
    }
    return `
        <div class="space-y-3">
            ${findings.map((finding, index) => {
                const parts = finding.split('###');
                const isStructured = parts.length > 1;
                const title = parts[0];
                const points = parts.slice(1);
                const findingContent = isStructured
                    ? `<span>${title}</span>${points.map(p => `<span class="block font-semibold">${p}</span>`).join('')}`
                    : title;

                return `
                <div
                    class="finding-item relative group p-3 pl-10 border-l-4 rounded-r-lg transition-all duration-200 bg-slate-50 border-blue-500"
                    data-batch-id="${batchId}"
                    data-finding-index="${index}"
                    data-finding-raw="${encodeURIComponent(finding)}"
                >
                    <div
                        class="selection-handle absolute left-0 top-0 bottom-0 w-8 flex items-center justify-center cursor-pointer"
                        role="checkbox"
                        aria-label="Toggle selection for this finding"
                    >
                        <div class="w-4 h-4 rounded-full border-2 transition-colors border-slate-400 bg-white group-hover:border-blue-500"></div>
                    </div>
                    <div class="finding-text font-bold text-slate-700 cursor-pointer">${findingContent}</div>
                    <div class="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-100 p-1 rounded-md shadow-sm">
                        <button class="edit-btn p-1 text-slate-600 hover:text-blue-600 rounded-full hover:bg-slate-200 transition-colors" aria-label="Edit text">
                            <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor"><path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828z" /><path fill-rule="evenodd" d="M2 6a2 2 0 012-2h4a1 1 0 010 2H4v10h10v-4a1 1 0 112 0v4a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clip-rule="evenodd" /></svg>
                        </button>
                    </div>
                </div>
            `}).join('')}
        </div>
    `;
};

export const generateSingleDictationHTML = (findings: string[]): string => {
    const content = `
        <div class="flex justify-between items-center mb-4">
            <h2 class="text-2xl font-bold text-slate-800">Corrected Findings</h2>
            ${findings.length > 0 ? `
            <button
                class="copy-all-btn text-sm font-semibold py-1 px-3 rounded-lg transition-colors bg-slate-200 text-slate-700 hover:bg-slate-300"
                data-batch-id="single"
            >
                Copy All
            </button>
            ` : ''}
        </div>
        
        <p class="text-slate-600 mb-6">Click any finding to copy it. To select multiple findings, click the circle on the left of each item.</p>

        ${renderFindingsList(findings, 'single')}
    `;
    return getHTMLTemplate('Radiology Dictation Report', content);
};

export const generateBatchDictationHTML = (batches: ReportBatch[]): string => {
    const processedBatches = batches.filter(b => b.findings && b.findings.length > 0);
    const content = `
        <div class="flex justify-between items-center mb-4">
            <h2 class="text-2xl font-bold text-slate-800">Processed Transcripts</h2>
            ${processedBatches.length > 0 ? `
            <button
                id="copy-all-transcripts"
                class="text-sm font-semibold py-1 px-3 rounded-lg transition-colors bg-slate-200 text-slate-700 hover:bg-slate-300"
            >
                Copy All Transcripts
            </button>
            ` : ''}
        </div>

        <div class="space-y-4">
        ${batches.map(batch => batch.findings ? `
            <div class="border rounded-lg" data-batch-container-id="${batch.id}">
                <div class="p-4 bg-slate-100">
                    <h3 class="font-semibold">${batch.name}</h3>
                </div>
                <div class="p-4 bg-white">
                    <div class="flex justify-end mb-4">
                        <button
                            class="copy-all-btn text-sm font-semibold py-1 px-3 rounded-lg transition-colors bg-slate-200 text-slate-700 hover:bg-slate-300"
                            data-batch-id="${batch.id}"
                        >
                            Copy All
                        </button>
                    </div>
                    ${renderFindingsList(batch.findings, batch.id)}
                </div>
            </div>
        ` : '').join('')}
        </div>
    `;
    return getHTMLTemplate('Batch Dictation Report', content);
};