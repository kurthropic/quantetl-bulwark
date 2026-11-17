"""Makes an AI training-data test corpus with known answers, for the AI Data tab and the AI pipeline steps.

Run: python3 make.py   (fixed seed, so the files are identical every run; all text and people are invented).

Writes:
  corpus.jsonl        20,000 documents: clean English text, 7 other languages, junk, planted personal data,
                      exact and near duplicates.
  eval.jsonl          500 evaluation questions; 150 of them are copied from (or quote) corpus.jsonl.
  support_chats.jsonl 2,000 customer-support question/answer pairs for the fine-tuning record step.
  answer.json         the exact answers (see README.md).
"""
import json, os, random

random.seed(31)
HERE = os.path.dirname(os.path.abspath(__file__))

# ---------- English: a small grammar with a large vocabulary, so documents don't overlap by accident ----------
SUBJ = ['the engineer', 'a young farmer', 'the city council', 'our research team', 'the old librarian', 'a delivery driver', 'the hospital board', 'a local baker',
        'the museum curator', 'the night nurse', 'a retired teacher', 'the river authority', 'a software tester', 'the school principal', 'the harbour master',
        'a field biologist', 'the regional manager', 'a street musician', 'the volunteer group', 'the train conductor', 'a market trader', 'the weather service',
        'the town planner', 'a graduate student', 'the factory owner', 'the ferry captain', 'a hotel receptionist', 'the court clerk', 'a beekeeper', 'the fire chief']
VERB = ['repaired', 'described', 'measured', 'questioned', 'painted', 'recorded', 'inspected', 'rebuilt', 'studied', 'replaced', 'catalogued', 'photographed',
        'cleaned', 'redesigned', 'tested', 'moved', 'translated', 'analysed', 'restored', 'counted', 'audited', 'mapped', 'planted', 'surveyed', 'sorted']
OBJ = ['the narrow bridge', 'an unusual pattern', 'the quarterly budget', 'several broken windows', 'the eastern orchard', 'a stack of letters', 'the water supply',
       'the ticket machines', 'an old railway map', 'the spring harvest', 'a set of tide tables', 'the noisy generator', 'the visitor survey', 'a damaged mural',
       'the parking rules', 'the cooling system', 'the bus timetable', 'an early manuscript', 'the solar panels', 'a box of seedlings', 'the flood barrier',
       'the payroll records', 'a rare orchid', 'the school garden', 'the radio tower', 'the bakery ovens', 'the emergency plan', 'a row of beehives']
TAIL = ['before the storm arrived', 'during the long winter', 'after the meeting ended', 'with surprising care', 'near the northern gate', 'without any help',
        'for the third time this year', 'while the town slept', 'under difficult conditions', 'as the deadline approached', 'despite the heavy rain',
        'in less than an hour', 'with a borrowed ladder', 'at the request of residents', 'following a short delay', 'using only hand tools',
        'beside the quiet canal', 'ahead of the festival', 'on a cold Tuesday morning', 'between two busy shifts']
LINK = ['Later,', 'Meanwhile,', 'As a result,', 'In the end,', 'At first,', 'Soon after,', 'Even so,', 'By evening,', 'For a while,', 'Afterwards,']
EXTRA = ['Nobody expected the results to be so clear.', 'The notes were filed in the archive the same day.', 'Several residents stopped to watch and ask questions.',
         'The work took longer than the original estimate.', 'A short report was shared with the neighbouring districts.', 'The cost stayed within the planned budget.',
         'Most people agreed that it had been worth the effort.', 'The next review is planned for the autumn.', 'A photograph of the work was printed in the local paper.',
         'Two apprentices helped and learned a great deal.']

def en_sentence():
    s = f'{random.choice(SUBJ)} {random.choice(VERB)} {random.choice(OBJ)} {random.choice(TAIL)}.'
    s = s[0].upper() + s[1:]
    r = random.random()
    if r < 0.25: s = f'{random.choice(LINK)} {s[0].lower() + s[1:]}'
    elif r < 0.4: s += ' ' + random.choice(EXTRA)
    if random.random() < 0.3: s = s[:-1] + f', and {random.randint(2, 900)} {random.choice(["people", "samples", "pages", "boxes", "trees", "visitors"])} were involved.'
    return s

def en_doc(lo=8, hi=24):
    paras = []
    for _ in range(random.randint(2, 4)):
        paras.append(' '.join(en_sentence() for _ in range(random.randint(lo // 3, hi // 3))))
    return '\n\n'.join(paras)

# ---------- Seven other languages: hand-written sentences, combined in random order ----------
LANG = {
 'es': ['El ayuntamiento aprobó un nuevo plan para mejorar el transporte público en la ciudad.', 'Los vecinos se reunieron en la plaza para hablar sobre el futuro del mercado.',
        'La biblioteca abrirá sus puertas los domingos a partir del próximo mes.', 'Muchos agricultores esperan que la lluvia llegue antes de la cosecha.',
        'El museo recibió una colección de cartas antiguas de un coleccionista privado.', 'Durante el invierno, el puerto tiene menos actividad que en verano.',
        'La escuela organizó una feria de ciencias con proyectos de todos los cursos.', 'Según el informe, el consumo de agua bajó un diez por ciento este año.',
        'El tren de la mañana llegó con retraso por una avería en la vía.', 'Los médicos del hospital pidieron más personal para el turno de noche.',
        'Una pequeña panadería del barrio ganó un premio por su pan de centeno.', 'El río creció mucho después de las tormentas de la semana pasada.',
        'Los estudiantes presentaron sus ideas para un parque más verde y seguro.', 'La empresa decidió instalar paneles solares en el techo de la fábrica.'],
 'fr': ['La mairie a présenté un nouveau projet pour rénover la place du marché.', 'Les habitants du quartier se sont réunis pour discuter de la circulation.',
        'Le musée a reçu une collection de lettres anciennes écrites par un marin.', 'Pendant l\'hiver, le port est beaucoup plus calme que pendant l\'été.',
        'Les agriculteurs attendent la pluie avant de commencer les récoltes.', 'La bibliothèque sera ouverte le dimanche à partir du mois prochain.',
        'Selon le rapport, la consommation d\'eau a baissé de dix pour cent cette année.', 'Le train du matin est arrivé en retard à cause d\'une panne sur la voie.',
        'Les médecins de l\'hôpital ont demandé plus de personnel pour la nuit.', 'Une petite boulangerie du village a gagné un prix pour son pain de seigle.',
        'Les élèves ont présenté leurs idées pour un parc plus vert et plus sûr.', 'L\'entreprise a décidé d\'installer des panneaux solaires sur le toit de l\'usine.',
        'La rivière a beaucoup monté après les orages de la semaine dernière.', 'Le conseil municipal votera le budget au début du mois de mars.'],
 'de': ['Die Stadtverwaltung hat einen neuen Plan für den öffentlichen Nahverkehr vorgestellt.', 'Die Nachbarn trafen sich auf dem Platz, um über den Markt zu sprechen.',
        'Das Museum erhielt eine Sammlung alter Briefe von einem privaten Sammler.', 'Im Winter ist im Hafen deutlich weniger los als im Sommer.',
        'Viele Bauern hoffen, dass der Regen noch vor der Ernte kommt.', 'Die Bibliothek wird ab dem nächsten Monat auch sonntags geöffnet sein.',
        'Laut dem Bericht ist der Wasserverbrauch in diesem Jahr um zehn Prozent gesunken.', 'Der Zug am Morgen kam wegen einer Störung auf der Strecke zu spät.',
        'Die Ärzte im Krankenhaus forderten mehr Personal für die Nachtschicht.', 'Eine kleine Bäckerei im Viertel gewann einen Preis für ihr Roggenbrot.',
        'Die Schüler stellten ihre Ideen für einen grüneren und sichereren Park vor.', 'Das Unternehmen will Solarzellen auf dem Dach der Fabrik installieren.',
        'Der Fluss ist nach den Gewittern der letzten Woche stark angestiegen.', 'Der Gemeinderat wird Anfang März über den Haushalt abstimmen.'],
 'it': ['Il comune ha presentato un nuovo piano per migliorare il trasporto pubblico.', 'Gli abitanti del quartiere si sono riuniti per parlare del futuro del mercato.',
        'Il museo ha ricevuto una collezione di lettere antiche da un collezionista privato.', 'Durante l\'inverno il porto è molto più tranquillo che in estate.',
        'Molti agricoltori sperano che la pioggia arrivi prima del raccolto.', 'La biblioteca sarà aperta anche la domenica a partire dal mese prossimo.',
        'Secondo il rapporto, il consumo di acqua è sceso del dieci per cento questo anno.', 'Il treno del mattino è arrivato in ritardo per un guasto sulla linea.',
        'I medici dell\'ospedale hanno chiesto più personale per il turno di notte.', 'Una piccola panetteria del paese ha vinto un premio per il suo pane di segale.',
        'Gli studenti hanno presentato le loro idee per un parco più verde e sicuro.', 'L\'azienda ha deciso di installare pannelli solari sul tetto della fabbrica.',
        'Il fiume è cresciuto molto dopo i temporali della settimana scorsa.', 'Il consiglio comunale voterà il bilancio all\'inizio di marzo.'],
 'pt': ['A prefeitura apresentou um novo plano para melhorar o transporte público da cidade.', 'Os moradores do bairro se reuniram na praça para falar sobre o mercado.',
        'O museu recebeu uma coleção de cartas antigas de um colecionador particular.', 'Durante o inverno, o porto fica muito mais calmo do que no verão.',
        'Muitos agricultores esperam que a chuva chegue antes da colheita.', 'A biblioteca vai abrir também aos domingos a partir do próximo mês.',
        'Segundo o relatório, o consumo de água caiu dez por cento este ano.', 'O trem da manhã chegou atrasado por causa de uma falha na linha.',
        'Os médicos do hospital pediram mais funcionários para o turno da noite.', 'Uma pequena padaria do bairro ganhou um prêmio pelo seu pão de centeio.',
        'Os estudantes apresentaram suas ideias para um parque mais verde e seguro.', 'A empresa decidiu instalar painéis solares no telhado da fábrica.',
        'O rio subiu muito depois das tempestades da semana passada.', 'A câmara municipal vai votar o orçamento no começo de março.'],
 'nl': ['De gemeente heeft een nieuw plan voor het openbaar vervoer gepresenteerd.', 'De buren kwamen op het plein bij elkaar om over de markt te praten.',
        'Het museum kreeg een verzameling oude brieven van een particuliere verzamelaar.', 'In de winter is het in de haven veel rustiger dan in de zomer.',
        'Veel boeren hopen dat de regen nog voor de oogst komt.', 'De bibliotheek is vanaf volgende maand ook op zondag open.',
        'Volgens het rapport is het waterverbruik dit jaar met tien procent gedaald.', 'De ochtendtrein kwam te laat door een storing op het spoor.',
        'De artsen in het ziekenhuis vroegen om meer personeel voor de nachtdienst.', 'Een kleine bakkerij in de wijk won een prijs voor haar roggebrood.',
        'De leerlingen presenteerden hun ideeën voor een groener en veiliger park.', 'Het bedrijf wil zonnepanelen op het dak van de fabriek leggen.',
        'De rivier is na de onweersbuien van vorige week sterk gestegen.', 'De gemeenteraad stemt begin maart over de begroting.'],
 'ru': ['Городская администрация представила новый план развития общественного транспорта.', 'Жители района собрались на площади, чтобы обсудить будущее рынка.',
        'Музей получил коллекцию старых писем от частного коллекционера.', 'Зимой в порту гораздо спокойнее, чем летом.',
        'Многие фермеры надеются, что дождь пойдёт до начала сбора урожая.', 'Со следующего месяца библиотека будет открыта и по воскресеньям.',
        'По данным отчёта, потребление воды в этом году снизилось на десять процентов.', 'Утренний поезд опоздал из-за неисправности на линии.',
        'Врачи больницы попросили больше сотрудников для ночной смены.', 'Небольшая пекарня в нашем районе получила премию за ржаной хлеб.',
        'Школьники представили свои идеи для более зелёного и безопасного парка.', 'Компания решила установить солнечные панели на крыше завода.',
        'После грозы на прошлой неделе уровень реки сильно поднялся.', 'Городской совет проголосует за бюджет в начале марта.'],
}

def lang_doc(lang):
    ss = random.sample(LANG[lang], random.randint(5, 9))
    return ' '.join(ss) + f' ({random.randint(1000, 99999)})'

# ---------- Junk: what quality filters should remove ----------
def junk():
    k = random.choice(['cookie', 'lorem', 'symbols', 'repeat', 'numbers', 'short'])
    site = random.choice(['shop', 'news', 'travel', 'recipes', 'sports', 'weather']) + str(random.randint(10, 9999))
    if k == 'cookie':
        return k, '\n'.join([f'Welcome to {site}.', 'We use cookies to improve your experience. Accept all cookies to continue.', 'Please enable JavaScript to view this page.',
                             f'Cookie policy | Privacy policy | Terms of use | All rights reserved {random.randint(2000, 2026)}', 'Subscribe to our newsletter for updates.'])
    if k == 'lorem':
        return k, f'Lorem ipsum dolor sit amet, consectetur adipiscing elit {random.randint(1, 10**6)}. ' + ' '.join(random.choice(['sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore', 'magna', 'aliqua']) for _ in range(random.randint(60, 120)))
    if k == 'symbols':
        return k, ' '.join(random.choice(['###', '#trending', '#sale', '…', '...', '#win', '#deal']) + ' ' + random.choice(['buy', 'now', 'best', 'price', 'click', 'here']) for _ in range(random.randint(40, 80))) + f' {site}'
    if k == 'repeat':
        line = random.choice(['Click here to read more', 'Add to cart', 'Free shipping on all orders', 'Limited offer today only', 'Share this post'])
        return k, '\n'.join([f'{site}'] + [line] * random.randint(20, 40) + ['See you next time.'])
    if k == 'numbers':
        return k, '\n'.join(' '.join(f'{random.randint(0, 99999):,}' for _ in range(8)) for _ in range(random.randint(10, 20)))
    return k, random.choice(['Read more', 'Next page', 'Loading...', 'Home | About | Contact', 'Sold out']) + f' {random.randint(1, 99)}'

# ---------- Personal data, valid by checksum ----------
def luhn_card(prefix):
    d = [int(x) for x in prefix] + [random.randint(0, 9) for _ in range(15 - len(prefix))]
    s = 0
    for i, x in enumerate(reversed(d)):
        y = x * 2 if i % 2 == 0 else x
        s += y - 9 if y > 9 else y
    d.append((10 - s % 10) % 10)
    c = ''.join(map(str, d))
    return ' '.join(c[i:i + 4] for i in range(0, 16, 4))
def iban():
    bban = 'QETL' + ''.join(str(random.randint(0, 9)) for _ in range(14))
    num = ''.join(str(int(ch, 36)) for ch in bban + 'GB00')
    return f'GB{98 - int(num) % 97:02d}{bban}'
FIRST = ['Ava', 'Ben', 'Chloe', 'Dev', 'Elif', 'Femi', 'Gita', 'Hugo', 'Ines', 'Jon', 'Kai', 'Lena']
LAST = ['Ahmed', 'Brown', 'Costa', 'Diaz', 'Evans', 'Garcia', 'Ito', 'Khan', 'Lopez', 'Novak', 'Perera']
def pii():
    kind = random.choice(['email', 'phone', 'card', 'ssn', 'iban', 'ipv4'])
    f, l = random.choice(FIRST), random.choice(LAST)
    v = {'email': f'{f}.{l}{random.randint(1, 999)}@example.com'.lower(), 'phone': f'+1 555 {random.randint(100, 999)} {random.randint(1000, 9999)}',
         'card': luhn_card(random.choice(['4', '51', '37'])), 'ssn': f'{random.randint(100, 665):03d}-{random.randint(10, 99):02d}-{random.randint(1000, 9999):04d}',
         'iban': iban(), 'ipv4': f'10.{random.randint(0, 255)}.{random.randint(0, 255)}.{random.randint(1, 254)}'}[kind]
    sentence = {'email': f'For details, {f} {l} can be reached at {v}.', 'phone': f'Call {f} on {v} if anything changes.', 'card': f'The deposit was paid with card {v} last week.',
                'ssn': f'The form listed social security number {v} by mistake.', 'iban': f'Refunds go to account {v} within five days.', 'ipv4': f'The upload came from address {v} at night.'}[kind]
    return kind, v, sentence

# ---------- Build the corpus ----------
docs, answer = [], {'languages': {}, 'junk': {}, 'pii': [], 'exact_groups': [], 'near_groups': []}
nid = [0]
def add(text, source, **meta):
    nid[0] += 1
    d = {'id': f'doc{nid[0]:05d}', 'text': text, 'source': source, 'meta': {'collected': f'2026-{random.randint(1, 10):02d}-{random.randint(1, 28):02d}', **meta}}
    docs.append(d); return d

clean = [add(en_doc(), 'web', lang='en') for _ in range(14200)]
for d in random.sample(clean, 400):
    kind, v, sent = pii()
    paras = d['text'].split('\n\n'); i = random.randrange(len(paras)); paras[i] += ' ' + sent; d['text'] = '\n\n'.join(paras)
    answer['pii'].append({'id': d['id'], 'kind': kind, 'value': v})
for lang in LANG:
    for _ in range(400): add(lang_doc(lang), 'web', lang=lang)
for _ in range(600):
    k, t = junk(); d = add(t, 'crawl'); answer['junk'][d['id']] = k

originals = random.sample([d for d in docs if d['source'] == 'web' and d['meta'].get('lang') == 'en' and not any(p['id'] == d['id'] for p in answer['pii'])], 2000)
for d in originals[:1200]:
    c = add(d['text'], 'mirror', lang='en'); answer['exact_groups'].append([d['id'], c['id']])
for d in originals[1200:]:
    w = d['text'].split(' '); n = len(w); k = max(2, round(n * random.uniform(0.04, 0.08)))
    style = random.choice(['replace', 'append', 'prepend'])
    new = en_sentence().split(' ')
    while len(new) < k: new += en_sentence().split(' ')
    new = new[:k]
    if style == 'replace': i = random.randrange(0, n - k); w = w[:i] + new + w[i + k:]
    elif style == 'append': w = w + new
    else: w = new + w
    c = add(' '.join(w), 'mirror', lang='en'); answer['near_groups'].append([d['id'], c['id'], style, k, n])

random.shuffle(docs)
for d in docs:
    lg = d['meta'].get('lang')
    if lg and d['source'] != 'crawl': answer['languages'][d['id']] = lg
with open(os.path.join(HERE, 'corpus.jsonl'), 'w') as fh:
    for d in docs: fh.write(json.dumps(d, ensure_ascii=False) + '\n')

# ---------- Evaluation set: 150 of 500 overlap with the corpus ----------
Q_SUBJ = ['Which planet', 'What instrument', 'Which river', 'What colour', 'Which mountain', 'What year', 'Which composer', 'What element', 'Which language', 'What animal']
Q_REST = ['is known for its rings', 'measures air pressure', 'flows through Cairo', 'do you get by mixing blue and yellow', 'is the tallest in Africa',
          'did the first moon landing happen', 'wrote the Four Seasons', 'has the symbol Fe', 'has the most native speakers', 'can sleep standing up']
evals, contaminated = [], []
english = [d for d in docs if d['source'] == 'web' and d['meta'].get('lang') == 'en']
for i in range(500):
    eid = f'eval{i + 1:03d}'
    if i < 75:
        src = random.choice(english); evals.append({'id': eid, 'question': src['text'], 'answer': 'n/a'}); contaminated.append({'id': eid, 'from': src['id'], 'how': 'copied'})
    elif i < 150:
        src = random.choice(english); w = src['text'].split(); s = random.randrange(0, max(1, len(w) - 30))
        q = f"{random.choice(Q_SUBJ)} {random.choice(Q_REST)}? Context: {' '.join(w[s:s + 30])}"
        evals.append({'id': eid, 'question': q, 'answer': 'n/a'}); contaminated.append({'id': eid, 'from': src['id'], 'how': 'quoted 30 words'})
    else:
        q = f'{random.choice(Q_SUBJ)} {random.choice(Q_REST)}? (variant {random.randint(1, 10**6)})'
        evals.append({'id': eid, 'question': q, 'answer': random.choice(['A', 'B', 'C', 'D'])})
order = list(range(500)); random.shuffle(order)
with open(os.path.join(HERE, 'eval.jsonl'), 'w') as fh:
    for i in order: fh.write(json.dumps(evals[i], ensure_ascii=False) + '\n')

# ---------- Support chats for the fine-tuning record step ----------
TOPICS = [('reset my password', 'Open Settings, choose Security and select Reset password. A link arrives by email within a few minutes.'),
          ('change my billing address', 'Go to Billing, select Edit next to your address, then save. The next invoice uses the new address.'),
          ('export my data', 'Open the dataset, go to the Export tab and choose CSV, JSONL or Parquet.'),
          ('cancel my subscription', 'In Billing, choose Cancel plan. You keep access until the end of the current period.'),
          ('add a team member', 'Open Settings, then Team, and send an invitation to their work email.'),
          ('download an invoice', 'Invoices are listed under Billing. Select one to download it as a PDF.')]
chats, chat_pii = [], 0
for i in range(2000):
    q, a = random.choice(TOPICS)
    question = f'Hi, how do I {q}? ' + random.choice(['Thanks!', 'It is urgent.', 'I tried twice already.', '', 'My manager asked me to do it today.'])
    if random.random() < 0.1:
        kind, v, sent = pii(); question += ' ' + sent; chat_pii += 1
    answer_text = a if random.random() > 0.05 else ''
    chats.append({'ticket': f'T{i + 1:05d}', 'question': question.strip(), 'answer': answer_text, 'channel': random.choice(['email', 'chat', 'phone'])})
with open(os.path.join(HERE, 'support_chats.jsonl'), 'w') as fh:
    for c in chats: fh.write(json.dumps(c, ensure_ascii=False) + '\n')

summary = {
    'documents': len(docs), 'languages': {l: sum(1 for v in answer['languages'].values() if v == l) for l in ['en', *LANG]},
    'junk': len(answer['junk']), 'junk_kinds': {k: list(answer['junk'].values()).count(k) for k in sorted(set(answer['junk'].values()))},
    'pii_documents': len(answer['pii']), 'exact_duplicates': len(answer['exact_groups']), 'near_duplicates': len(answer['near_groups']),
    'eval_rows': 500, 'eval_contaminated': len(contaminated), 'chats': len(chats), 'chats_without_answer': sum(1 for c in chats if not c['answer']), 'chats_with_pii': chat_pii,
}
answer['summary'] = summary; answer['contaminated'] = contaminated
with open(os.path.join(HERE, 'answer.json'), 'w') as fh: json.dump(answer, fh, indent=1, ensure_ascii=False)
print(json.dumps(summary, indent=2))
