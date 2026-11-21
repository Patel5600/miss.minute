package com.patel5600.missminute.mobile.bridge;

import com.patel5600.missminute.mobile.core.protocol.Role;

/** Only the restricted migration renderer may access Android's legacy browser database. */
final class RendererStoragePolicy {
    private static final String BLOCK_SCRIPT = "(function(){var blocked=false;try{Object.defineProperty(globalThis,'indexedDB',{configurable:false,enumerable:false,get:function(){return undefined}});blocked=typeof globalThis.indexedDB==='undefined'}catch(e){}if(!blocked){try{window.stop();document.open();document.write('<!doctype html><title>Miss Minutes</title><p>Secure storage controls are unavailable. Update Android System WebView and reopen.</p>');document.close()}catch(e){}}})();";

    private RendererStoragePolicy() { }

    static boolean shouldBlockIndexedDb(Role role) {
        return role != Role.MIGRATION;
    }

    static boolean requiresDocumentStartBlocker(Role role) {
        return shouldBlockIndexedDb(role);
    }

    static boolean canHost(Role role, boolean webMessageListener, boolean documentStartScript) {
        return webMessageListener && (!requiresDocumentStartBlocker(role) || documentStartScript);
    }

    static String indexedDbBlockScript() {
        return BLOCK_SCRIPT;
    }
}
