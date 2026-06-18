import test from "node:test";
import assert from "node:assert/strict";

import { escapeHTML, formatCloseNotificationHTML, renderDeployVisual } from "../telegram.js";

test("escapeHTML escapes Telegram HTML-sensitive dynamic text", () => {
  assert.equal(escapeHTML(`A&B < C > D "quote" 'apos'`), "A&amp;B &lt; C &gt; D &quot;quote&quot; &#39;apos&#39;");
});

test("formatCloseNotificationHTML keeps intended tags but escapes close reasons", () => {
  const html = formatCloseNotificationHTML({
    pair: "PAIR<SOL>&X",
    pnlUsd: 0.02,
    pnlPct: 0.08,
    autoSwapFailed: true,
    baseLabel: "TOK<bad>",
    reason: "Protective close: pnl 0.00% < 1.5% & fee/TVL >= 5%",
  });

  assert.match(html, /<b>Closed<\/b>/);
  assert.match(html, /PAIR&lt;SOL&gt;&amp;X/);
  assert.match(html, /pnl 0\.00% &lt; 1\.5% &amp; fee\/TVL &gt;= 5%/);
  assert.match(html, /TOK&lt;bad&gt;/);
  assert.doesNotMatch(html, /pnl 0\.00% < 1\.5%/);
});

test("renderDeployVisual escapes pool labels inside bold tag", () => {
  const html = renderDeployVisual({
    pair: "EVIL<SOL>",
    amountSol: 0.5,
    lowerPrice: 0.00001,
    upperPrice: 0.00002,
    activePrice: 0.000015,
    binStep: 100,
    baseFee: "0.1<bad>",
    band: "B",
  });

  assert.match(html, /<b>EVIL&lt;SOL&gt;<\/b>/);
  assert.match(html, /0\.1&lt;bad&gt;/);
});
