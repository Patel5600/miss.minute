"""Text front-end: turns chat text into speakable chunks.

Handles markdown/emoji, numbers, times, a few TVA names, and sentence chunking so the
first audio can start before the whole reply is synthesized.
"""
from __future__ import annotations

import re

# Paralinguistic tags the Chatterbox Turbo/Nano models understand. Anything else in
# square brackets is dropped so a stray "[1]" from a chat reply is never read aloud.
TAGS = ("clear throat", "chuckle", "laugh", "cough", "sigh", "gasp", "groan", "sniff", "shush")

LEXICON = {
    r"\bTVA\b": "T V A",
    r"\bTemPads?\b": "Tem Pad",
    r"\bMinutemen\b": "Minute men",
    r"\bMr\.": "Mister",
    r"\bMrs\.": "Missus",
    r"\bMs\.": "Miss",
    r"\bDr\.": "Doctor",
    r"\bvs\.?": "versus",
    r"\be\.g\.": "for example",
    r"\bi\.e\.": "that is",
}

_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
         "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
_ORD = {"one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth",
        "nine": "ninth", "twelve": "twelfth"}


def number_to_words(n: int) -> str:
    if n < 0:
        return "minus " + number_to_words(-n)
    if n < 20:
        return _ONES[n]
    if n < 100:
        tens, ones = divmod(n, 10)
        return _TENS[tens] + ("-" + _ONES[ones] if ones else "")
    if n < 1000:
        hundreds, rest = divmod(n, 100)
        return _ONES[hundreds] + " hundred" + (" " + number_to_words(rest) if rest else "")
    for size, name in ((10**9, "billion"), (10**6, "million"), (1000, "thousand")):
        if n >= size:
            head, rest = divmod(n, size)
            return number_to_words(head) + " " + name + (" " + number_to_words(rest) if rest else "")
    return str(n)


def _ordinal(n: int) -> str:
    """Only the final word changes: twenty-one -> twenty-first, one hundred -> one hundredth."""
    words = number_to_words(n)
    tail = re.search(r"[a-z]+$", words)
    last = tail.group(0)
    if last in _ORD:
        new = _ORD[last]
    elif last.endswith("y"):
        new = last[:-1] + "ieth"
    else:
        new = last + "th"
    return words[: tail.start()] + new


def _year(n: int) -> str:
    if 2000 <= n <= 2009:
        return "two thousand" + (" " + _ONES[n - 2000] if n > 2000 else "")
    hi, lo = divmod(n, 100)
    if lo == 0:
        return number_to_words(hi) + " hundred"
    return number_to_words(hi) + " " + ("oh " + _ONES[lo] if lo < 10 else number_to_words(lo))


def _sentence_dot(match: re.Match) -> str:
    """Keep a sentence-ending period that the "a.m." / "pm." pattern consumed."""
    if not match.group(0).endswith("."):
        return ""
    rest = match.string[match.end():]
    return "." if (not rest.strip() or re.match(r"\s+[A-Z\[\"']", rest)) else ""


def _sub_clock(match: re.Match) -> str:
    hour, minute = int(match.group(1)), int(match.group(2))
    if minute > 59 or hour > 24:
        return match.group(0)
    meridiem = (match.group(3) or "").replace(".", "").lower()
    return _time_words(hour, minute, meridiem) + _sentence_dot(match)


def _sub_hour(match: re.Match) -> str:
    hour = int(match.group(1))
    if hour > 12 or hour == 0:
        return match.group(0)
    return _time_words(hour, 0, match.group(2).lower() + "m") + _sentence_dot(match)


def _time_words(hour: int, minute: int, meridiem: str) -> str:
    spoken_hour = (hour % 12 or 12) if (meridiem or hour <= 12) else hour
    words = number_to_words(spoken_hour)
    if minute == 0:
        words += "" if meridiem else " o'clock"
    elif minute < 10:
        words += " oh " + number_to_words(minute)
    else:
        words += " " + number_to_words(minute)
    if meridiem == "am":
        words = "midnight" if hour in (0, 12) and minute == 0 else words + " in the morning"
    elif meridiem == "pm":
        if hour == 12 and minute == 0:
            words = "twelve noon"
        elif hour == 12 or hour < 6:
            words += " in the afternoon"
        elif hour < 10:
            words += " in the evening"
        else:
            words += " at night"
    return words


def expand_numbers(text: str) -> str:
    text = re.sub(r"\b(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?(?!\w)", _sub_clock, text, flags=re.I)
    text = re.sub(r"\b(\d{1,2})\s*([ap])\.?m\.?(?!\w)", _sub_hour, text, flags=re.I)
    text = re.sub(r"([$₹])\s?(\d[\d,]*)(?:\.(\d{2}))?", _money, text)
    text = re.sub(r"\b(\d+)(?:st|nd|rd|th)\b", lambda m: _ordinal(int(m.group(1))), text)
    text = re.sub(r"(-?\d+(?:\.\d+)?)\s?°\s?([CF])\b",
                  lambda m: _num(m.group(1)) + " degrees " + ("Celsius" if m.group(2) == "C" else "Fahrenheit"), text)
    text = re.sub(r"(-?\d+(?:\.\d+)?)\s?°", lambda m: _num(m.group(1)) + " degrees", text)
    text = re.sub(r"(-?\d+(?:\.\d+)?)\s?%", lambda m: _num(m.group(1)) + " percent", text)
    text = re.sub(r"\b(1[1-9]\d{2}|20\d{2})\b", lambda m: _year(int(m.group(1))), text)
    text = re.sub(r"\d[\d,]*(?:\.\d+)?", lambda m: _num(m.group(0)), text)
    return text


def _num(raw: str) -> str:
    raw = raw.replace(",", "")
    if "." in raw:
        whole, frac = raw.split(".", 1)
        return number_to_words(int(whole or "0")) + " point " + " ".join(_ONES[int(d)] for d in frac)
    return number_to_words(int(raw))


def _money(match: re.Match) -> str:
    unit = "dollars" if match.group(1) == "$" else "rupees"
    amount = int(match.group(2).replace(",", ""))
    words = number_to_words(amount) + " " + (unit[:-1] if amount == 1 else unit)
    if match.group(3) and int(match.group(3)):
        words += " " + number_to_words(int(match.group(3))) + (" cents" if unit == "dollars" else " paise")
    return words


def clean(text: str) -> str:
    """Make chat text speakable without changing its meaning."""
    text = re.sub(r"```[\s\S]*?```", " Code block. ", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"https?://\S+", " a link ", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)  # markdown link -> label
    text = re.sub(r"[*_#>~|]+", " ", text)
    text = re.sub(r"[\u2600-\u27BF\U0001F000-\U0001FAFF\uFE0F]", "", text)  # emoji and dingbats

    def keep_tag(match: re.Match) -> str:
        tag = match.group(1).strip().lower()
        return f"[{tag}]" if tag in TAGS else " "

    text = re.sub(r"\[([^\]]{1,20})\]", keep_tag, text)
    for pattern, replacement in LEXICON.items():
        text = re.sub(pattern, replacement, text)
    text = expand_numbers(text)
    text = text.replace("&", " and ").replace("@", " at ").replace("+", " plus ")
    text = re.sub(r"[\r\n]+", ". ", text)
    text = re.sub(r"\.(\s*\.)+", ".", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def chunk(text: str, max_chars: int = 220, first_max: int = 110, min_chars: int = 40) -> list[str]:
    """Split into sentence-sized chunks.

    The first chunk is capped lower so audio starts sooner; very short sentences are merged
    into their neighbour so each synthesized piece keeps natural prosody.
    """
    text = clean(text)
    if not text:
        return []
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+(?=[A-Z\[\"'])", text) if s.strip()]
    pieces: list[str] = []
    for sentence in sentences:
        while len(sentence) > (first_max if not pieces else max_chars):
            limit = first_max if not pieces else max_chars
            cut = max(sentence.rfind(", ", 0, limit), sentence.rfind("; ", 0, limit),
                      sentence.rfind(" ", 0, limit))
            if cut < 30:
                cut = limit
            pieces.append(sentence[: cut + 1].strip())
            sentence = sentence[cut + 1:].strip()
        if sentence:
            pieces.append(sentence)

    chunks: list[str] = []
    for piece in pieces:
        limit = first_max if len(chunks) == 1 else max_chars  # keep the opening chunk short
        if chunks and len(chunks[-1]) < min_chars and len(chunks[-1]) + 1 + len(piece) <= limit:
            chunks[-1] += " " + piece
        else:
            chunks.append(piece)
    return chunks
