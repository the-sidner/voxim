# VISION

> Dies ist kein Design-Dokument. Es ist eine Orientierung. Wenn du beim Bauen
> nicht mehr weißt, warum du etwas tust, lies das hier. Wenn du vor einer
> Entscheidung stehst und mehrere Wege funktional gleich gut wären, lies das
> hier und entscheide dich für den Weg, der mit dem hier Beschriebenen
> kohärenter ist.

---

## Was wir bauen

Wir bauen kein Spiel. Wir bauen einen Ort, an dem eine bestimmte Erfahrung
möglich wird. Das Spiel ist die Form, in der dieser Ort sich materialisiert,
aber die Form ist nicht der Zweck. Der Zweck ist die Erfahrung, und die
Erfahrung lässt sich am besten so beschreiben:

*Ein Spieler tritt in eine Welt, deren Regeln er nicht vollständig versteht,
deren Geschichte größer ist als das, was er in einem Spielleben sehen kann,
deren moralische Fragen keine sauberen Antworten haben, und in der seine
Handlungen Konsequenzen haben, die er nicht kontrollieren und oft nicht
einmal sehen kann. Er handelt trotzdem, weil das Nicht-Handeln auch eine
Handlung ist. Am Ende, wenn sein Charakter stirbt oder seine Linie
weiterzieht, soll der Spieler nicht das Gefühl haben, etwas gewonnen oder
verloren zu haben. Er soll das Gefühl haben, in einer Welt gewesen zu sein,
die ihn verändert hat, weil sie ihn gezwungen hat, Entscheidungen unter
Bedingungen zu treffen, die jeder leichten Lösung widerstehen.*

Das ist die Erfahrung. Alles andere — die Mechanik, die Grafik, die
Interface-Entscheidungen, der Multiplayer, die Persistenz — ist Mittel zu
diesem Zweck. Wenn eine Mechanik gegen diese Erfahrung arbeitet, gehört sie
nicht ins Spiel, auch wenn sie elegant oder beliebt oder einfach umzusetzen
ist.

## Was wir nicht bauen

Wir bauen kein Power-Fantasy-Spiel. Der Spieler soll sich nicht stark fühlen.
Er soll sich verantwortlich fühlen, und Verantwortung ist das Gegenteil von
Stärke — sie ist das Wissen, dass die eigenen Handlungen wirken, ohne dass
man sie kontrolliert.

Wir bauen kein Storytelling-Spiel im klassischen Sinn. Es gibt keine
zentrale Erzählung, die der Spieler durchläuft. Die Welt erzählt sich selbst,
und der Spieler ist eine Stimme darin, nicht die Hauptfigur einer geplanten
Handlung.

Wir bauen kein Sandbox-Spiel im klassischen Sinn. Sandboxen sind moralisch
neutral — der Spieler kann tun, was er will, und die Welt akzeptiert es.
Unsere Welt akzeptiert nichts. Sie reagiert. Sie merkt sich. Sie wirft
Schatten zurück, manchmal sofort, manchmal Generationen später.

Wir bauen kein Spiel, das den Spieler unterhält. Wir bauen ein Spiel, das
den Spieler *anwesend* macht. Unterhaltung ist der Modus, in dem die Zeit
schnell vergeht. Anwesenheit ist der Modus, in dem die Zeit langsamer wird,
weil jede Entscheidung ein Gewicht hat.

## Die zentrale Erfahrung

Die zentrale Erfahrung des Spiels lässt sich in einem Satz zusammenfassen:

**Du handelst in einer Welt, deren Tiefe du nie ganz verstehst, und du musst
mit den Konsequenzen leben, ohne zu wissen, ob dein Handeln das Richtige
war.**

Dieser Satz hat mehrere Implikationen, die für jede Designentscheidung
relevant sind:

**„Du handelst"** — der Spieler ist nicht Beobachter. Er ist nicht Held. Er
ist Handelnder, und das Handeln ist der Kern des Spiels. Wenn eine Mechanik
das Handeln zur Routine macht, untergräbt sie die Erfahrung. Jede Handlung
sollte sich nach etwas anfühlen.

**„In einer Welt"** — die Welt existiert vor dem Spieler und nach dem
Spieler. Sie hat ihre eigene Geschichte, ihre eigene Geographie, ihre eigene
Logik. Der Spieler ist Gast, nicht Mittelpunkt. Das Spiel sollte nie so tun,
als wäre es für den Spieler gemacht — die Welt soll sich anfühlen wie ein
Ort, der existiert, ob jemand zuschaut oder nicht.

**„Deren Tiefe du nie ganz verstehst"** — der Spieler darf nie den Eindruck
bekommen, alle Regeln zu kennen. Es muss immer eine Schicht unter dem geben,
was er gerade sieht. Lore-Dokumente, die alles erklären, sind verboten.
Mechaniken, die ihre Funktionsweise vollständig offenlegen, sind verboten.
Die Welt soll sich rätselhaft anfühlen, nicht weil Information versteckt
wird, sondern weil die Welt zu groß ist, um vollständig erfasst zu werden.

**„Du musst mit den Konsequenzen leben"** — Aktionen haben dauerhafte
Folgen. Tod ist nicht reversibel. Entscheidungen sind nicht zurücknehmbar.
Speicherstände, die das Zurückgehen erlauben, untergraben die Erfahrung.
Wenn ein Spieler einen Fehler macht, lebt er mit dem Fehler, oder er gibt
auf und beginnt mit einem neuen Charakter, der die Welt erbt, in der der
Fehler gemacht wurde.

**„Ohne zu wissen, ob dein Handeln das Richtige war"** — das Spiel gibt
keine moralischen Bewertungen. Es gibt keine Karma-Anzeige, keine
Gut-Böse-Achse, keine Belohnungen für „richtiges" Verhalten. Die Welt
reagiert auf Handlungen, aber die Reaktionen sind nicht moralisch lesbar.
Manchmal führt eine gute Tat zu einer schlimmen Folge. Manchmal führt eine
egoistische Tat zu einer unerwarteten Rettung. Die Welt ist nicht gerecht
und nicht ungerecht. Sie ist *strukturiert*, und die Struktur ist nicht
moralisch.

## Die philosophische Grundlage

Das Spiel basiert auf einer metaphysischen Position, die nicht ausgesprochen
werden muss, aber jede Designentscheidung durchdringt. Die Position ist:

**Wir wissen nicht, wie die Welt wirklich ist. Wir können nur handeln, als
ob unsere Handlungen wichtig wären, in dem Wissen, dass wir nie wissen
werden, ob sie es waren.**

Diese Position wird im Spiel auf drei Weisen sichtbar:

1. **Niemand im Spiel kennt die volle Kosmologie.** Nicht die Priester, nicht
   die Alchemisten, nicht die Baq-Seher, nicht die Spielfiguren. Jede Kultur
   hat ihre Theorie, und jede Theorie ist partiell richtig und partiell
   falsch, und niemand kann wissen, welche Teile welche sind. Der Spieler
   wird nie eine Enthüllung bekommen, die ihm sagt, „so ist es wirklich".
   Diese Enthüllung gibt es nicht, weder im Spiel noch in der Welt, die das
   Spiel modelliert.

2. **Handlungen haben Folgen, die nicht linear sind.** Eine gute Tat in
   einem Teil der Welt kann in einem anderen Teil eine schlimme Folge haben,
   verschoben in Zeit und Raum, unsichtbar für den Handelnden. Dies ist
   keine Bestrafung und keine Lehre. Es ist die Struktur der Welt. Spieler
   werden lernen, mit dieser Struktur zu leben, indem sie aufhören zu
   versuchen, sie zu optimieren, und stattdessen anfangen, nach ihrem
   eigenen Maßstab zu handeln.

3. **Würde ist möglich, aber nicht garantiert.** Ein Charakter, der sein
   Leben lang versucht hat, ein Mensch zu bleiben, hat etwas erreicht, auch
   wenn er nichts gerettet, nichts gewonnen, nichts hinterlassen hat. Die
   Würde ist die einzige Form von Erfolg, die in dieser Welt verfügbar ist,
   und sie ist nicht messbar, nicht sichtbar, nicht belohnbar. Sie ist eine
   private Angelegenheit zwischen dem Charakter und sich selbst. Das Spiel
   sollte Räume öffnen, in denen Spieler diese Würde für ihre Charaktere
   suchen können, ohne dass das Spiel ihnen sagt, ob sie sie gefunden haben.

## Die Sechs Säulen — neu gelesen

Die ursprünglichen sechs Designsäulen bleiben gültig, aber sie sollten im
Licht der oben beschriebenen Erfahrung gelesen werden:

1. **Persistenz** — die Welt existiert ohne Beobachter, weil sie nicht für
   die Beobachter da ist. Die Welt ist nicht der Hintergrund des Spielers,
   sondern eine eigenständige Tatsache.

2. **Schatten als Antagonist** — das Böse ist nicht Gegner, sondern eine
   thermodynamische Konsequenz von Handeln. Es lässt sich verschieben, aber
   nicht besiegen. Spieler, die versuchen, es zu besiegen, werden lernen,
   dass jeder Sieg woanders eine Niederlage erzeugt. Das ist nicht
   Frustration, sondern Erkenntnis.

3. **Wissen als physischer Gegenstand** — das Geschriebene ist die einzige
   Form von Unsterblichkeit. Was nicht geschrieben ist, geht mit dem Tod
   verloren. Diese Mechanik ist die direkte Übersetzung der metaphysischen
   Position, dass Seelen sich auflösen und nur Spuren in der Welt
   weiterleben.

4. **Tod als Generationenwechsel** — Charaktere sterben, Linien bleiben.
   Was ein Vorfahre getan hat, lebt in der Welt seines Erben weiter, oft
   ohne dass der Erbe weiß, woher die Bedingungen seines Lebens kommen.
   Das ist das Karma-Prinzip, aber ohne Gerechtigkeit: man erbt nicht das,
   was man verdient, sondern das, was die Vorfahren hinterlassen haben.

5. **Material trägt Bedeutung** — die voxelbasierte Komposition bedeutet,
   dass jeder Gegenstand eine Geschichte hat. Ein Schwert aus Eisen, das
   in einer bestimmten Region geschmiedet wurde, ist nicht austauschbar mit
   einem Schwert aus Eisen, das woanders geschmiedet wurde. Diese
   Spezifizität ist die Form, in der die Welt ihre eigene Tiefe materiell
   ausdrückt.

6. **Komplexität durch Komposition** — emergentes Verhalten statt
   gescriptete Handlung. Die Welt soll Spieler überraschen, weil sie aus
   Regeln besteht, die zusammenwirken, nicht aus geplanten Ereignissen.
   Das ist die Form, in der die Welt ihre eigene Unwissbarkeit modelliert:
   selbst der Designer kann nicht alle Konsequenzen vorhersehen.

## Was Spieler erleben sollen

Wenn alles funktioniert, wird ein Spieler nach hundert Stunden in der Welt
folgendes sagen können:

- **„Ich habe Dinge getan, die ich nicht erklären kann."** Nicht weil das
  Spiel verwirrend ist, sondern weil die Situationen, in die er kam,
  Entscheidungen verlangten, die jenseits einfacher Begründungen lagen. Er
  hat gehandelt, und die Handlung war richtig oder falsch oder beides, und
  er weiß es nicht.

- **„Ich habe Dinge gesehen, die ich nicht vergessen werde."** Nicht weil
  das Spiel Schock-Effekte einsetzt, sondern weil die Welt Momente
  hervorbringt, die das Bewusstsein des Spielers für eine Sekunde aus
  seiner gewohnten Spur drücken. Diese Momente werden selten sein, aber sie
  müssen real sein.

- **„Ich habe jemanden verloren, und der Verlust hat etwas bedeutet."**
  Nicht weil das Spiel emotionale Manipulation betreibt, sondern weil die
  Bindungen, die der Spieler in der Welt aufbaut, real waren — zu seinem
  Charakter, zu seinen NPCs, zu seinem Hearth, zu seiner Linie. Wenn ein
  Charakter stirbt, ist es nicht Game Over. Es ist ein Verlust, mit dem die
  Welt weiterlebt.

- **„Ich war nicht der Held."** Spieler in diesem Spiel sind kleine
  Bewegungen in einem großen Feld. Manche von ihnen werden Dinge tun, die
  in der Welt Spuren hinterlassen, die andere Spieler später sehen. Aber
  niemand wird die Welt retten, weil die Welt nicht zu retten ist, weil
  Rettung eine Kategorie ist, die in dieser Welt nicht existiert.

## Was wir vermeiden müssen

Folgende Versuchungen werden während der Entwicklung kommen, und wir müssen
ihnen widerstehen:

- **Die Versuchung, dem Spieler zu erklären, was er erlebt.** Tutorials,
  Codex-Einträge, die alles aufschlüsseln, NPCs, die Lore in Dialogen
  ausspucken — all das ist die einfache Lösung, und sie zerstört die
  Erfahrung. Wenn der Spieler etwas wissen muss, soll er es entdecken, und
  wenn er es nicht entdeckt, soll er ohne dieses Wissen leben.

- **Die Versuchung, das Spiel fairer zu machen.** Faire Spiele belohnen
  Können und bestrafen Fehler in einer berechenbaren Weise. Unsere Welt
  ist nicht fair. Sie ist konsequent, aber die Konsequenzen sind nicht
  immer absehbar. Spieler, die gewinnen wollen, werden frustriert sein.
  Spieler, die *anwesend sein* wollen, werden bleiben.

- **Die Versuchung, die Mechanik zu verfeinern, bis sie elegant ist.**
  Eleganz ist ein Wert, aber sie ist nicht der höchste Wert. Manchmal ist
  eine raue, etwas widerständige Mechanik besser, weil sie den Spieler
  zwingt, sich mit ihr auseinanderzusetzen, statt sie zu beherrschen. Die
  Welt soll sich nicht wie ein Werkzeug anfühlen, das man bedient, sondern
  wie ein Material, mit dem man arbeitet.

- **Die Versuchung, Erfolge sichtbar zu machen.** Achievements, Ränge,
  sichtbare Statistiken, die zeigen, wie „weit" man gekommen ist — all das
  zerstört die Anwesenheit, weil es den Spieler aus der Welt herauszieht
  und in ein Bewertungssystem stellt. Erfolge in dieser Welt sollen
  privat sein, zwischen dem Spieler und seinem Charakter.

- **Die Versuchung, andere Spiele zu kopieren, weil sie funktionieren.**
  Was bei anderen Spielen funktioniert, funktioniert oft, weil es die
  Erfahrung erzeugt, die diese Spiele wollen. Unsere Erfahrung ist eine
  andere. Mechaniken aus anderen Spielen müssen daraufhin geprüft werden,
  ob sie unserer Erfahrung dienen oder ihr widersprechen, nicht darauf,
  ob sie populär oder bewährt sind.

## Der Maßstab

Wenn wir uns fragen, ob etwas ins Spiel gehört, ist die Frage nicht: *macht
es Spaß?* oder *ist es elegant?* oder *funktioniert es technisch?* — sondern:

**Bringt es den Spieler näher an die Erfahrung, die wir oben beschrieben
haben?**

Wenn ja, kommt es ins Spiel.
Wenn nein, kommt es nicht ins Spiel, egal wie gut es sonst ist.
Wenn unklar, ist die Antwort vorerst *nein*, bis wir es besser verstehen.

## Schlusswort

Dieses Dokument ist nicht statisch. Es wird sich verändern, wenn wir mehr
verstehen. Aber die Kernrichtung sollte konstant bleiben: wir bauen einen
Ort, an dem eine bestimmte Form von Anwesenheit möglich wird, und alles
andere ist Mittel zum Zweck.

Wenn wir uns verlaufen, lesen wir dieses Dokument noch einmal und fragen
uns, ob das, was wir gerade tun, mit dem hier Beschriebenen kohärent ist.
Wenn nicht, korrigieren wir den Kurs. Wenn ja, machen wir weiter.

Die Welt wartet darauf, gebaut zu werden. Sie ist es wert.