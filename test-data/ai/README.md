# AI training-data test files

Made by `make.py` (fixed random seed, so the files are identical every run). All text and people are invented: the
card numbers only pass the Luhn check and the IBANs use a made-up bank code. `check.js` runs every AI Data step
against `answer.json`:

```
python3 test-data/ai/make.py
node test-data/ai/check.js
```

## corpus.jsonl: 19,600 documents

- **Clean English text:** 14,200 documents. 400 of them have one planted personal-data value each (email, phone,
  card, SSN, IBAN or IP address).
- **Other languages:** 2,800 documents, 400 each in Spanish, French, German, Italian, Portuguese, Dutch and Russian.
- **Junk:** 600 documents. Cookie banners, lorem ipsum, symbol spam, repeated lines, number tables and very short
  pages.
- **Duplicates:** 1,200 exact copies and 800 near duplicates of earlier documents. The near duplicates have a span of
  4–8% of their words replaced, added at the start or added at the end.

## eval.jsonl: 500 evaluation questions

150 of the 500 overlap with the corpus: 75 are copies of a corpus document and 75 quote 30 words from one.

## support_chats.jsonl: 2,000 question and answer pairs

98 pairs have no answer, and 179 questions contain personal data.

## Results (checked on 2026-11-17)

| Check | Result |
|---|---|
| Exact duplicates | 1,200 of 1,200 found, each labelled "Exact duplicate" |
| Near duplicates | 767 of 800 found (95.9%); 3 documents wrongly removed (precision 99.85%) |
| Quality filter (document rules) | 600 of 600 junk documents removed; 117 of 19,000 clean documents also removed (0.6%: fewer than 50 words, or repeated phrases) |
| Language (texts over 20 words) | 19,000 of 19,000 correct |
| Personal data | 400 of 400 planted values redacted; no other documents changed |
| Contamination | 150 of 150 found, 0 false alarms |
| Fine-tuning records | 1,902 chat records; the 98 pairs without an answer are skipped |
| Browser vs. server | The 7-step pipeline gives byte-identical output in the browser and in chunked server runs (16,915 rows kept) |

Repeated junk pages are also removed by the duplicate step (154 of them). They are left out of the precision figure
because they really are near-identical.

Run against the cleaned output instead of the raw corpus, the contamination check finds 149 of the 150 overlapping
questions. The 150th was copied from a corpus document that the cleaning steps removed, so it is no longer in the
training data.
