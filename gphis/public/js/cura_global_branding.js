// apps/cura/cura/public/js/cura_global_branding.js

$(document).on('app_ready', function() {
    // 1. Setup target words and their replacement
    const wordsToReplace = [/Marley Health/gi, /Healthcare/gi, /ERPNext/gi];
    const replacementText = "Cura";

    // 2. Core function to scan text nodes and replace targets
    function replaceBrandingInElement(element) {
        if (!element) return;

        // Traverse all child nodes to find raw text node structures safely
        let walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while (node = walker.nextNode()) {
            let text = node.nodeValue;
            let updated = false;

            wordsToReplace.forEach(regex => {
                if (regex.test(text)) {
                    text = text.replace(regex, replacementText);
                    updated = true;
                }
            });

            if (updated) {
                node.nodeValue = text;
            }
        }
    }

    // 3. Initial replacement on application load
    replaceBrandingInElement(document.body);

    // 4. Watch for sidebar toggles, routes, and lazy-loaded items
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    replaceBrandingInElement(node);
                }
            });
        });
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
});
