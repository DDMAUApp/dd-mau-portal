// Food Safety section: modules for the "food-safety" training track.
//
// Source of truth: Projects/DD Mau Training/ServSafe-vs-County-Report.md
// (Nov 4, 2026). The law at both stores is St. Louis County Chapter 807
// (FDA Food Code 2005 plus county changes). Lessons teach the stricter rule and
// give the ServSafe exam's answer as an "EXAM NOTE" where it differs. FS1-FS7
// quizzes test our rule. Only FS8 tests the exam's answer, labeled in the question.
//
// Legal limits (report section 9): written in our own words from FDA and county
// text with DD Mau's kitchen examples. No paraphrasing the ServSafe book, no
// practice-test or remembered exam questions, no logo, no module named "ServSafe"
// and no claim of meeting a certification. The exam-review line lives only in the
// FS8 first lesson.
//
// English and Spanish arrays match paragraph for paragraph
// (training.validation.test). Lesson markers are the same as Manager Training:
//   "## Heading", "!! TITLE: body" callout, "| a | b |" table rows.
// All modules start as draft: true (admins only). tier "all" means every staff
// member sees them once published, including the manager study.

export const FS1_CLEAN_HANDS = {
    id: "fs1",
    code: "FS1",
    track: "food-safety",
    tier: "all",
    draft: true,
    icon: "🧼",
    durationMin: 25,
    titleEn: "Clean Hands and Working Sick",
    titleEs: "Manos Limpias y Trabajar Enfermo",
    lessons: [
        {
            id: "fs1-l1",
            titleEn: "Washing your hands",
            titleEs: "Lavarte las manos",
            contentEn: [
                "Hands carry germs from raw pork, phones and restrooms onto rice, herbs and bánh mì. A quick rinse doesn't remove them. A full wash does.",
                "## How to wash",
                "| Step | Do this |",
                "| Water | Warm and running, at least 100°F at every hand sink |",
                "| Scrub | 10-15 seconds with soap, under the nails and between the fingers |",
                "| Total time | At least 20 seconds, start to finish |",
                "| Dry | Towel or heated-air dryer |",
                "## When to wash",
                "• Before you start food work and before you put on gloves",
                "• After the restroom, eating, drinking, smoking or vaping",
                "• After touching your face, hair or body, or after coughing, sneezing or using a tissue",
                "• After raw meat, and any time you go from raw food to ready-to-eat food",
                "• After dirty dishes, garbage, money or chemicals",
                "• Any time you change tasks",
                "Wash only at a hand sink, never at a prep, dish or mop sink. A hand sink stays easy to reach and is used for hands only. No pans, no ice, no food.",
                "Hand antiseptic is an extra step after washing, never a replacement. Let it dry before you touch food.",
                "!! EXAM NOTE: The ServSafe exam answer for hand sink water is 85°F. County law says 100°F, so 100°F is our rule."
            ],
            contentEs: [
                "Las manos llevan gérmenes del puerco crudo, los teléfonos y los baños al arroz, las hierbas y el bánh mì. Una enjuagada rápida no los quita. Un lavado completo sí.",
                "## Cómo lavarte",
                "| Paso | Qué hacer |",
                "| Agua | Tibia y corriendo, al menos 100°F en cada lavamanos |",
                "| Tallar | 10-15 segundos con jabón, debajo de las uñas y entre los dedos |",
                "| Tiempo total | Al menos 20 segundos, de principio a fin |",
                "| Secar | Toalla o secador de aire caliente |",
                "## Cuándo lavarte",
                "• Antes de empezar a trabajar con comida y antes de ponerte guantes",
                "• Después del baño, de comer, beber, fumar o vapear",
                "• Después de tocarte la cara, el pelo o el cuerpo, o después de toser, estornudar o usar un pañuelo",
                "• Después de tocar carne cruda, y cada vez que pases de comida cruda a comida lista para comer",
                "• Después de platos sucios, basura, dinero o químicos",
                "• Cada vez que cambies de tarea",
                "Lávate solo en un lavamanos, nunca en un fregadero de preparación, de platos o de trapeador. El lavamanos siempre debe estar fácil de alcanzar y se usa solo para las manos. Nada de sartenes, hielo ni comida.",
                "El antiséptico de manos es un paso extra después de lavarte, nunca un reemplazo. Deja que se seque antes de tocar comida.",
                "!! NOTA DE EXAMEN: La respuesta del examen ServSafe para el agua del lavamanos es 85°F. La ley del condado dice 100°F, así que nuestra regla es 100°F."
            ]
        },
        {
            id: "fs1-l2",
            titleEn: "Gloves and bare hands",
            titleEs: "Guantes y manos sin guantes",
            contentEn: [
                "County law: no bare hands on ready-to-eat food. Ready-to-eat means food that won't be cooked again before the guest eats it. Clean hands don't change this rule.",
                "| Food | Use |",
                "| Spring rolls, where everything is ready-to-eat | Gloves or another barrier |",
                "| Bánh mì fillings and pickles | Gloves, tongs or deli sheets |",
                "| Washed herbs, sprouts and lettuce | Gloves or tongs |",
                "| Sliced rare beef for pho | Gloves or tongs |",
                "| Cooked rice and noodles | Spatula, tongs or gloves |",
                "| Herbs, sauces and cooked ingredients going to the wok | Still gloves or a utensil |",
                "## Glove rules",
                "• One pair, one task. Wash your hands before you put them on.",
                "• Throw them away when they tear, get dirty or the task gets interrupted.",
                "• House rule: change after 4 hours of steady use, even if they look fine.",
                "• A cut-resistant glove can't touch ready-to-eat food unless a single-use glove goes over it.",
                "• A cut on your hand gets a waterproof bandage and a glove, every time.",
                "!! EXAM NOTE: The ServSafe exam allows bare hands on a ready-to-eat item going into a dish that will be cooked. County law has no such exception, so we use gloves or a utensil."
            ],
            contentEs: [
                "Ley del condado: nada de manos sin guantes en comida lista para comer. Lista para comer significa comida que no se va a volver a cocinar antes de que el cliente se la coma. Tener las manos limpias no cambia esta regla.",
                "| Comida | Usa |",
                "| Spring rolls, donde todo está listo para comer | Guantes u otra barrera |",
                "| Rellenos de bánh mì y encurtidos | Guantes, pinzas u hojas de deli |",
                "| Hierbas, germinados y lechuga ya lavados | Guantes o pinzas |",
                "| Carne de res rara en rebanadas para pho | Guantes o pinzas |",
                "| Arroz y fideos cocidos | Espátula, pinzas o guantes |",
                "| Hierbas, salsas e ingredientes cocidos que van al wok | También guantes o un utensilio |",
                "## Reglas de guantes",
                "• Un par, una tarea. Lávate las manos antes de ponértelos.",
                "• Tíralos cuando se rompan, se ensucien o se interrumpa la tarea.",
                "• Regla de la casa: cámbialos después de 4 horas de uso seguido, aunque se vean bien.",
                "• Un guante anticortes no puede tocar comida lista para comer a menos que lleve encima un guante desechable.",
                "• Una cortada en la mano lleva una venda impermeable y un guante, siempre.",
                "!! NOTA DE EXAMEN: El examen ServSafe permite manos sin guantes con un ingrediente listo para comer que va a un platillo que se va a cocinar. La ley del condado no tiene esa excepción, así que usamos guantes o un utensilio."
            ]
        },
        {
            id: "fs1-l3",
            titleEn: "Personal hygiene",
            titleEs: "Higiene personal",
            contentEn: [
                "| Item | Rule |",
                "| Nails | Trimmed and filed. Polish or false nails only under intact gloves |",
                "| Jewelry | None on hands or arms, including watches and medical jewelry. A plain band is the only exception |",
                "| Hair | Hat or hair restraint in prep areas |",
                "| Clothes | Clean outer clothing. Take your apron off before the restroom |",
                "| Eating and drinking | Only in the designated area. A closed drink is fine if it's handled so it can't contaminate anything |",
                "| Tobacco and vapes | Designated areas only, then wash your hands |",
                "| Tasting | Use a clean utensil once, then send it to be washed |",
                "Tasting pho broth twice with the same spoon breaks the rule. Grab a new spoon each time.",
                "Showering before your shift and taking your apron off for the restroom are DD Mau habits. They aren't in the county's words, but the exam teaches them too."
            ],
            contentEs: [
                "| Tema | Regla |",
                "| Uñas | Cortas y limadas. Esmalte o uñas postizas solo debajo de guantes en buen estado |",
                "| Joyas | Ninguna en manos o brazos, incluyendo relojes y joyas médicas. Un anillo liso es la única excepción |",
                "| Pelo | Gorra o malla en las áreas de preparación |",
                "| Ropa | Ropa exterior limpia. Quítate el delantal antes de ir al baño |",
                "| Comer y beber | Solo en el área designada. Una bebida cerrada está bien si se maneja de modo que no contamine nada |",
                "| Tabaco y vapeo | Solo en áreas designadas, y después lávate las manos |",
                "| Probar comida | Usa un utensilio limpio una vez y mándalo a lavar |",
                "Probar el caldo de pho dos veces con la misma cuchara rompe la regla. Toma una cuchara nueva cada vez.",
                "Bañarte antes del turno y quitarte el delantal para ir al baño son hábitos de DD Mau. No están en las palabras del condado, pero el examen también los enseña."
            ]
        },
        {
            id: "fs1-l4",
            titleEn: "Tell us before you work",
            titleEs: "Avísanos antes de trabajar",
            contentEn: [
                "If you're sick, tell the person in charge before you touch anything. Call before you come in if you can. The person in charge is the manager or lead responsible for food safety on that shift.",
                "## Symptoms to report",
                "• Vomiting or diarrhea",
                "• Yellow skin or eyes (jaundice) or dark urine",
                "• Sore throat with fever, or fever alone",
                "• A boil, open sore or infected cut",
                "## Illnesses to report",
                "Tell us if a provider diagnoses you with any of these: norovirus, hepatitis A, Shigella, Shiga toxin E. coli, Salmonella Typhi or nontyphoidal Salmonella.",
                "Also tell us if you were part of a confirmed outbreak, or if someone in your home has one of those illnesses.",
                "Two words matter. Exclude means you stay out of the building. Restrict means you work away from food, clean equipment and unwrapped single-use items.",
                "!! CALL NOW: The person in charge calls the county immediately for jaundice or a listed diagnosis: (314) 615-8900, Mon-Fri 8:00-4:30, or food.dph@stlouiscountymo.gov.",
                "Any ready-to-eat food a sick worker may have contaminated gets thrown out.",
                "Persistent sneezing, coughing or a runny nose keeps you away from exposed food and clean items until it stops."
            ],
            contentEs: [
                "Si estás enfermo, avísale a la persona a cargo antes de tocar cualquier cosa. Llama antes de venir si puedes. La persona a cargo es el gerente o líder responsable de la seguridad de la comida en ese turno.",
                "## Síntomas que debes avisar",
                "• Vómito o diarrea",
                "• Piel u ojos amarillos (ictericia) u orina oscura",
                "• Dolor de garganta con fiebre, o fiebre sola",
                "• Un absceso, llaga abierta o cortada infectada",
                "## Enfermedades que debes avisar",
                "Avísanos si un médico te diagnostica alguna de estas: norovirus, hepatitis A, Shigella, E. coli productora de toxina Shiga, Salmonella Typhi o Salmonella no tifoidea.",
                "También avísanos si fuiste parte de un brote confirmado, o si alguien en tu casa tiene una de esas enfermedades.",
                "Dos palabras importan. Excluir significa que te quedas fuera del edificio. Restringir significa que trabajas lejos de la comida, del equipo limpio y de los artículos desechables sin envolver.",
                "!! LLAMAR YA: La persona a cargo llama al condado de inmediato por ictericia o un diagnóstico de la lista: (314) 615-8900, lunes a viernes 8:00-4:30, o food.dph@stlouiscountymo.gov.",
                "Toda comida lista para comer que un trabajador enfermo pudo haber contaminado se tira.",
                "Estornudos seguidos, tos o nariz que gotea te mantienen lejos de la comida expuesta y de los artículos limpios hasta que se te quite."
            ]
        },
        {
            id: "fs1-l5",
            titleEn: "When you can come back",
            titleEs: "Cuándo puedes regresar",
            contentEn: [
                "The person in charge uses this table. Treat these conditions as required, not optional.",
                "| Condition | While it lasts | Back to work |",
                "| Vomiting or diarrhea, no diagnosis | Stay out | 24 hours symptom-free, or a provider's note that it isn't infectious |",
                "| Norovirus with symptoms | Stay out. After 24 hours symptom-free, away from food | County approval, plus a note or more than 48 hours symptom-free |",
                "| Shigella or Shiga toxin E. coli with symptoms | Stay out. After 24 hours symptom-free, away from food | County approval, plus 2 negative cultures or more than 7 days symptom-free |",
                "| Nontyphoidal Salmonella | Stay out while sick, then away from food | County approval, plus 2 negative tests or 30 days |",
                "| Jaundice within 7 days, or hepatitis A | Stay out | County approval, plus more than 7 days jaundiced, more than 14 days with other symptoms, or a provider's note |",
                "| Salmonella Typhi, now or within 3 months | Stay out | County approval and a provider's note |",
                "| Norovirus, no symptoms | Away from food | County approval, plus a note or more than 48 hours since diagnosis |",
                "| Shigella or E. coli, no symptoms | Away from food | County approval, plus negative tests or more than 7 days since diagnosis |",
                "| Sore throat with fever | Away from food | A provider's note |",
                "| Boil or infected wound, uncovered | Away from food | Hand or wrist: waterproof cover and glove. Arm: waterproof cover. Elsewhere: dry, tight bandage |",
                "Fever alone, open sores, boils or dark urine: stay off food unless a provider finds it isn't related to a food germ. This comes from Missouri's wider list, and we use the wider list."
            ],
            contentEs: [
                "La persona a cargo usa esta tabla. Trata estas condiciones como obligatorias, no opcionales.",
                "| Condición | Mientras dura | Regresar a trabajar |",
                "| Vómito o diarrea, sin diagnóstico | Fuera | 24 horas sin síntomas, o nota de un médico de que no es contagioso |",
                "| Norovirus con síntomas | Fuera. Después de 24 horas sin síntomas, lejos de la comida | Aprobación del condado, más una nota o más de 48 horas sin síntomas |",
                "| Shigella o E. coli de toxina Shiga con síntomas | Fuera. Después de 24 horas sin síntomas, lejos de la comida | Aprobación del condado, más 2 cultivos negativos o más de 7 días sin síntomas |",
                "| Salmonella no tifoidea | Fuera mientras estés enfermo, luego lejos de la comida | Aprobación del condado, más 2 pruebas negativas o 30 días |",
                "| Ictericia en los últimos 7 días, o hepatitis A | Fuera | Aprobación del condado, además de más de 7 días con ictericia, más de 14 días con otros síntomas, o nota de un médico |",
                "| Salmonella Typhi, ahora o en los últimos 3 meses | Fuera | Aprobación del condado y nota de un médico |",
                "| Norovirus, sin síntomas | Lejos de la comida | Aprobación del condado, más una nota o más de 48 horas desde el diagnóstico |",
                "| Shigella o E. coli, sin síntomas | Lejos de la comida | Aprobación del condado, más pruebas negativas o más de 7 días desde el diagnóstico |",
                "| Dolor de garganta con fiebre | Lejos de la comida | Nota de un médico |",
                "| Absceso o herida infectada, sin cubrir | Lejos de la comida | Mano o muñeca: cubierta impermeable y guante. Brazo: cubierta impermeable. En otro lugar: venda seca y ajustada |",
                "Fiebre sola, llagas abiertas, abscesos u orina oscura: no trabajes con comida a menos que un médico determine que no tiene relación con un germen de comida. Esto viene de la lista más amplia de Missouri, y usamos la lista más amplia."
            ]
        },
        {
            id: "fs1-l6",
            titleEn: "Hepatitis A proof",
            titleEs: "Comprobante de hepatitis A",
            contentEn: [
                "This is a St. Louis County law. No food handler may work past day 30 without written proof from a provider. Normal cooking doesn't reliably kill this virus.",
                "## Who needs it",
                "Anyone who prepares or touches food (except uncut produce), utensils, serving items or surfaces. That covers cooks, and it also covers cashiers and runners who handle serving items or wipe surfaces.",
                "## What counts as proof",
                "| Your situation | Proof |",
                "| Already immune | Provider's written proof |",
                "| Fully vaccinated | Vaccine, with a booster 6-12 months after the first shot |",
                "| Just started the shots | First shot now, and booster proof within one year |",
                "## Exemptions",
                "• Pregnancy",
                "• A religious objection on a notarized county form, which gets forwarded to the county",
                "• A medical reason verified in writing by a licensed physician",
                "The employer keeps your proof for your whole job, at the store or the home office, and shows it on request.",
                "Old county pages say 2 weeks. The code says 30 days, and the code controls. Bring your proof early so day 30 never catches you."
            ],
            contentEs: [
                "Esta es una ley del condado de St. Louis. Ninguna persona que maneje comida puede trabajar después del día 30 sin un comprobante escrito de un médico. La cocción normal no mata este virus de forma confiable.",
                "## Quién lo necesita",
                "Toda persona que prepare o toque comida (excepto frutas y verduras sin cortar), utensilios, artículos para servir o superficies. Eso incluye a los cocineros, y también a los cajeros y runners que manejan artículos para servir o limpian superficies.",
                "## Qué cuenta como comprobante",
                "| Tu situación | Comprobante |",
                "| Ya eres inmune | Comprobante escrito del médico |",
                "| Vacuna completa | Vacuna, con refuerzo 6-12 meses después de la primera dosis |",
                "| Apenas empezaste las dosis | Primera dosis ahora, y comprobante del refuerzo dentro de un año |",
                "## Exenciones",
                "• Embarazo",
                "• Una objeción religiosa en un formulario notarizado del condado, que se envía al condado",
                "• Una razón médica verificada por escrito por un médico con licencia",
                "El empleador guarda tu comprobante durante todo tu empleo, en la tienda o en la oficina central, y lo muestra si se lo piden.",
                "Páginas viejas del condado dicen 2 semanas. El código dice 30 días, y manda el código. Trae tu comprobante temprano para que el día 30 nunca te agarre."
            ]
        }
    ],
    quiz: {
        passThreshold: 0.85,
        questions: [
            {
                id: "fs1-q1",
                questionEn: "You test the back hand sink and the water only gets to 85°F. A coworker says that's fine. What do you do?",
                questionEs: "Pruebas el lavamanos de atrás y el agua solo llega a 85°F. Un compañero dice que está bien. ¿Qué haces?",
                options: [
                    { id: "a", textEn: "Nothing, 85°F is warm enough to use here", textEs: "Nada, 85°F es suficiente para usarlo aquí" },
                    { id: "b", textEn: "Wash at the prep sink for the rest of the shift, since that water runs hotter", textEs: "Lavarte en el fregadero de preparación el resto del turno, porque esa agua sale más caliente" },
                    { id: "c", textEn: "Tell the person in charge, because our hand sinks must reach 100°F", textEs: "Avisarle a la persona a cargo, porque nuestros lavamanos deben llegar a 100°F" },
                    { id: "d", textEn: "Scrub for longer to make up for the cool water", textEs: "Tallar más tiempo para compensar el agua fría" }
                ],
                correct: "c"
            },
            {
                id: "fs1-q2",
                questionEn: "You just washed your hands well and you're rolling spring rolls for the lunch rush. Can you skip gloves?",
                questionEs: "Acabas de lavarte bien las manos y estás enrollando spring rolls para el almuerzo. ¿Puedes no usar guantes?",
                options: [
                    { id: "a", textEn: "Yes, clean hands are enough", textEs: "Sí, las manos limpias son suficientes" },
                    { id: "b", textEn: "No, spring rolls are ready-to-eat, so you need gloves or another barrier", textEs: "No, los spring rolls están listos para comer, así que necesitas guantes u otra barrera" },
                    { id: "c", textEn: "Yes, if you use hand antiseptic after washing, because that makes hands food-safe", textEs: "Sí, si usas antiséptico después de lavarte, porque eso deja las manos seguras para la comida" },
                    { id: "d", textEn: "Only when the manager is watching", textEs: "Solo cuando el gerente está viendo" }
                ],
                correct: "b"
            },
            {
                id: "fs1-q3",
                questionEn: "A cook grabs a pinch of cilantro with bare hands and says, \"It's going in the wok anyway.\" What's our rule?",
                questionEs: "Un cocinero agarra cilantro con la mano sin guante y dice: \"De todos modos va al wok.\" ¿Cuál es nuestra regla?",
                options: [
                    { id: "a", textEn: "Fine, because the wok will cook it", textEs: "Está bien, porque el wok lo va a cocinar" },
                    { id: "b", textEn: "Fine, as long as it's less than a handful", textEs: "Está bien, si es menos de un puñado" },
                    { id: "c", textEn: "Fine, if the cilantro was washed first, because washing makes it safe to touch", textEs: "Está bien, si el cilantro se lavó antes, porque lavarlo hace que se pueda tocar" },
                    { id: "d", textEn: "Not allowed. Use gloves or a utensil, even going to the wok", textEs: "No se permite. Usa guantes o un utensilio, aunque vaya al wok" }
                ],
                correct: "d"
            },
            {
                id: "fs1-q4",
                questionEn: "You're wearing gloves to fill egg rolls with raw pork, and a guest order needs herbs on a bowl. What's next?",
                questionEs: "Traes guantes para rellenar egg rolls con puerco crudo, y una orden necesita hierbas en un bowl. ¿Qué sigue?",
                options: [
                    { id: "a", textEn: "Take the gloves off, wash your hands, put on new gloves", textEs: "Quitarte los guantes, lavarte las manos, ponerte guantes nuevos" },
                    { id: "b", textEn: "Wipe the gloves on a sanitizer towel and keep going, since that's faster", textEs: "Limpiar los guantes con un trapo con sanitizante y seguir, porque es más rápido" },
                    { id: "c", textEn: "Pull a new pair over the old pair", textEs: "Ponerte un par nuevo encima del viejo" },
                    { id: "d", textEn: "Use tongs while still wearing the same gloves", textEs: "Usar pinzas con los mismos guantes puestos" }
                ],
                correct: "a"
            },
            {
                id: "fs1-q5",
                questionEn: "You nicked your finger yesterday and you're working the pho line today. What does your hand need?",
                questionEs: "Ayer te cortaste un dedo y hoy trabajas en la línea de pho. ¿Qué necesita tu mano?",
                options: [
                    { id: "a", textEn: "A fabric bandage is enough", textEs: "Una curita de tela es suficiente" },
                    { id: "b", textEn: "Nothing, if the cut stopped bleeding", textEs: "Nada, si la cortada dejó de sangrar" },
                    { id: "c", textEn: "A waterproof bandage and a glove", textEs: "Una venda impermeable y un guante" },
                    { id: "d", textEn: "A glove with nothing under it", textEs: "Un guante sin nada debajo" }
                ],
                correct: "c"
            },
            {
                id: "fs1-q6",
                questionEn: "You threw up at 3 AM and feel fine for your 10 AM shift. No doctor visit. What's the rule?",
                questionEs: "Vomitaste a las 3 AM y te sientes bien para tu turno de las 10 AM. No fuiste al médico. ¿Cuál es la regla?",
                options: [
                    { id: "a", textEn: "Come in, since you feel fine", textEs: "Venir, ya que te sientes bien" },
                    { id: "b", textEn: "Tell the person in charge. Stay out until 24 hours symptom-free or a provider's note", textEs: "Avisarle a la persona a cargo. Quedarte fuera hasta 24 horas sin síntomas o nota de un médico" },
                    { id: "c", textEn: "Come in, but only work the register until a full shift has gone by with no more symptoms", textEs: "Venir, pero trabajar solo en la caja hasta que pase un turno completo sin más síntomas" },
                    { id: "d", textEn: "Come in and wear double gloves", textEs: "Venir y usar doble guante" }
                ],
                correct: "b"
            },
            {
                id: "fs1-q7",
                questionEn: "A coworker's eyes look yellow, and he says he's felt tired all week. You're the person in charge. What do you do?",
                questionEs: "Un compañero tiene los ojos amarillos y dice que lleva toda la semana cansado. Tú eres la persona a cargo. ¿Qué haces?",
                options: [
                    { id: "a", textEn: "Send him to dish, away from the line", textEs: "Mandarlo a lavar platos, lejos de la línea" },
                    { id: "b", textEn: "Let him finish the shift and call tomorrow", textEs: "Dejarlo terminar el turno y llamar mañana" },
                    { id: "c", textEn: "Tell him to drink water and wear a mask", textEs: "Decirle que tome agua y use cubrebocas" },
                    { id: "d", textEn: "Exclude him and call the county right away", textEs: "Excluirlo y llamar al condado de inmediato" }
                ],
                correct: "d"
            },
            {
                id: "fs1-q8",
                questionEn: "A cashier on day 25 wipes tables and hands out serving items but never cooks. She has no Hepatitis A proof. What applies?",
                questionEs: "Una cajera en su día 25 limpia mesas y entrega artículos para servir, pero nunca cocina. No tiene comprobante de hepatitis A. ¿Qué aplica?",
                options: [
                    { id: "a", textEn: "She needs proof by day 30, because the rule covers surfaces and serving items", textEs: "Necesita comprobante para el día 30, porque la regla cubre superficies y artículos para servir" },
                    { id: "b", textEn: "Nothing, since the rule is only for cooks", textEs: "Nada, porque la regla es solo para cocineros" },
                    { id: "c", textEn: "She has one year to get proof", textEs: "Tiene un año para conseguir el comprobante" },
                    { id: "d", textEn: "Nothing, if she took a food handler class, because a card takes the place of the proof", textEs: "Nada, si tomó una clase de manejo de alimentos, porque la tarjeta reemplaza el comprobante" }
                ],
                correct: "a"
            },
            {
                id: "fs1-q9",
                questionEn: "A new hire brings proof of the first Hepatitis A shot in week 2. What's still needed?",
                questionEs: "Un empleado nuevo trae comprobante de la primera dosis de hepatitis A en la semana 2. ¿Qué falta?",
                options: [
                    { id: "a", textEn: "Nothing, one shot finishes it", textEs: "Nada, una dosis lo termina" },
                    { id: "b", textEn: "A new shot every 30 days", textEs: "Una dosis nueva cada 30 días" },
                    { id: "c", textEn: "Booster proof within one year", textEs: "Comprobante del refuerzo dentro de un año" },
                    { id: "d", textEn: "A signed note from the manager", textEs: "Una nota firmada por el gerente" }
                ],
                correct: "c"
            },
            {
                id: "fs1-q10",
                questionEn: "A prep cook tastes the pho broth with a spoon, adds fish sauce, and reaches for the same spoon to taste again. What should happen?",
                questionEs: "Un cocinero prueba el caldo de pho con una cuchara, agrega salsa de pescado y va a usar la misma cuchara para probar otra vez. ¿Qué debe pasar?",
                options: [
                    { id: "a", textEn: "Rinse the spoon in the broth first", textEs: "Enjuagar la cuchara primero en el caldo" },
                    { id: "b", textEn: "Use a clean spoon. A tasting utensil is used once, then washed", textEs: "Usar una cuchara limpia. El utensilio de probar se usa una vez y se lava" },
                    { id: "c", textEn: "It's fine, because hot broth kills anything on the spoon between one taste and the next", textEs: "Está bien, porque el caldo caliente mata lo que haya en la cuchara entre una probada y otra" },
                    { id: "d", textEn: "Wipe the spoon on a clean towel", textEs: "Limpiar la cuchara con un trapo limpio" }
                ],
                correct: "b"
            }
        ]
    }
};

export const FS2_ALLERGENS = {
    id: "fs2",
    code: "FS2",
    track: "food-safety",
    tier: "all",
    draft: true,
    icon: "🥜",
    durationMin: 20,
    titleEn: "Allergens",
    titleEs: "Alérgenos",
    lessons: [
        {
            id: "fs2-l1",
            titleEn: "The nine major allergens",
            titleEs: "Los nueve alérgenos principales",
            contentEn: [
                "We teach nine. This table shows common places to look. It isn't our menu list, so always check the current allergen matrix and the recipe for a real dish.",
                "| Allergen | Common places to look |",
                "| Milk | Condensed milk, ganache |",
                "| Eggs | Mayo-style sauces, fried eggs |",
                "| Fish | Fish sauce |",
                "| Crustacean shellfish | Shrimp, crab |",
                "| Tree nuts | Almonds, cashews |",
                "| Wheat | Bread, some wrappers and noodles |",
                "| Peanuts | Peanut sauces, crushed peanuts |",
                "| Soybeans | Soy sauce, tofu |",
                "| Sesame | Sesame oil, sesame seeds |",
                "## Two items guests ask about",
                "Coconut: keep telling guests it's there, even though FDA dropped it from its tree nut list. A guest who avoids coconut needs to know.",
                "Oyster sauce: keep the warning, but oysters are mollusks and aren't one of the nine. Don't call them crustacean shellfish.",
                "!! EXAM NOTE: The county's older list has no sesame and adds up to 8. The ServSafe exam and FDA's newer code say nine, with sesame. Teach and follow nine."
            ],
            contentEs: [
                "Enseñamos nueve. Esta tabla muestra lugares comunes donde buscar. No es la lista de nuestro menú, así que siempre revisa la matriz de alérgenos actual y la receta de cada platillo.",
                "| Alérgeno | Dónde buscar |",
                "| Leche | Leche condensada, ganache |",
                "| Huevos | Salsas tipo mayonesa, huevos fritos |",
                "| Pescado | Salsa de pescado |",
                "| Mariscos crustáceos | Camarón, cangrejo |",
                "| Nueces de árbol | Almendras, nueces de la India |",
                "| Trigo | Pan, algunas envolturas y fideos |",
                "| Cacahuates | Salsas de cacahuate, cacahuate triturado |",
                "| Soya | Salsa de soya, tofu |",
                "| Ajonjolí | Aceite de ajonjolí, semillas de ajonjolí |",
                "## Dos cosas que preguntan los clientes",
                "Coco: sigue avisando a los clientes que lo lleva, aunque la FDA lo quitó de su lista de nueces de árbol. Un cliente que evita el coco necesita saberlo.",
                "Salsa de ostión: mantén la advertencia, pero los ostiones son moluscos y no son de los nueve. No los llames mariscos crustáceos.",
                "!! NOTA DE EXAMEN: La lista más vieja del condado no tiene ajonjolí y suma 8. El examen ServSafe y el código más nuevo de la FDA dicen nueve, con ajonjolí. Enseña y sigue nueve."
            ]
        },
        {
            id: "fs2-l2",
            titleEn: "When a guest has a reaction",
            titleEs: "Cuando un cliente tiene una reacción",
            contentEn: [
                "A reaction can start within minutes or take up to 2 hours.",
                "## Signs",
                "• Wheezing or trouble breathing",
                "• Hives or itching",
                "• Swelling of the tongue or throat",
                "• Stomach cramps",
                "• A drop in blood pressure, such as fainting",
                "!! SEVERE REACTION: Call emergency services and stay with the person. Then get the person in charge."
            ],
            contentEs: [
                "Una reacción puede empezar en minutos o tardar hasta 2 horas.",
                "## Señales",
                "• Silbidos al respirar o dificultad para respirar",
                "• Ronchas o comezón",
                "• Hinchazón de la lengua o la garganta",
                "• Cólicos de estómago",
                "• Baja de la presión, como desmayarse",
                "!! REACCIÓN GRAVE: Llama a los servicios de emergencia y quédate con la persona. Luego busca a la persona a cargo."
            ]
        },
        {
            id: "fs2-l3",
            titleEn: "Cross-contact in the kitchen",
            titleEs: "Contacto cruzado en la cocina",
            contentEn: [
                "Cross-contact means an allergen gets onto food that shouldn't have it. Tongs from the peanut garnish, a glove with sesame oil, or a wok with soy sauce in it are enough. Cooking doesn't undo it.",
                "## Making an allergy order",
                "• Check the recipe and labels first",
                "• Wash your hands and change your gloves",
                "• Use clean tools and a separate utensil",
                "• Add nothing after plating unless you checked it",
                "• If the kitchen can't make it safely, say so. Don't serve it",
                "!! NO EXCEPTIONS: If cross-contact happened, throw the food out, then clean and sanitize. Scraping off the peanuts or picking off the shrimp doesn't fix it. This is a DD Mau house rule."
            ],
            contentEs: [
                "Contacto cruzado significa que un alérgeno llega a una comida que no debe tenerlo. Basta con las pinzas del cacahuate, un guante con aceite de ajonjolí o un wok con salsa de soya. Cocinarlo no lo arregla.",
                "## Cómo hacer una orden con alergia",
                "• Revisa primero la receta y las etiquetas",
                "• Lávate las manos y cámbiate los guantes",
                "• Usa herramientas limpias y un utensilio aparte",
                "• No agregues nada después de emplatar sin haberlo revisado",
                "• Si la cocina no puede prepararlo de forma segura, dilo. No lo sirvas",
                "!! SIN EXCEPCIONES: Si hubo contacto cruzado, tira la comida y luego limpia y sanitiza. Quitar los cacahuates o sacar el camarón no lo arregla. Esta es una regla de la casa de DD Mau."
            ]
        },
        {
            id: "fs2-l4",
            titleEn: "What to tell a guest",
            titleEs: "Qué decirle a un cliente",
            contentEn: [
                "Never answer an allergy question from memory.",
                "| Step | What you do |",
                "| Ask | \"Is this an allergy?\" |",
                "| Check | Look at the current matrix and the recipe |",
                "| Read back | Repeat the order and the allergy to the guest |",
                "| Tell the kitchen | A written note on the ticket, plus say it out loud |",
                "| Confirm | Check the plate before it goes out |",
                "If the matrix and the recipe don't agree, or you aren't sure, get the person in charge and tell the guest you can't promise it. An honest \"I can't confirm that\" protects the guest.",
                "## Written notice",
                "FDA's newer code and the ServSafe program expect written allergen notice for guests, on paper or on a screen. The county code doesn't require it for unpackaged food. Use only a written sheet a manager has approved, and don't make your own list.",
                "## Food packaged here",
                "Anything we package in-house to sell must list its common name, ingredients, net quantity, business name and address, and the food source of each allergen. County law already requires this."
            ],
            contentEs: [
                "Nunca contestes una pregunta de alergia de memoria.",
                "| Paso | Qué haces |",
                "| Pregunta | \"¿Es una alergia?\" |",
                "| Revisa | Mira la matriz actual y la receta |",
                "| Repite | Repítele al cliente la orden y la alergia |",
                "| Avisa a la cocina | Una nota escrita en el ticket, y además dilo en voz alta |",
                "| Confirma | Revisa el plato antes de que salga |",
                "Si la matriz y la receta no coinciden, o no estás seguro, busca a la persona a cargo y dile al cliente que no puedes prometerlo. Un \"no puedo confirmarlo\" honesto protege al cliente.",
                "## Aviso por escrito",
                "El código más nuevo de la FDA y el programa ServSafe esperan un aviso escrito de alérgenos para los clientes, en papel o en pantalla. El código del condado no lo exige para comida sin empacar. Usa solo una hoja escrita aprobada por un gerente, y no hagas tu propia lista.",
                "## Comida empacada aquí",
                "Todo lo que empacamos aquí para vender debe llevar su nombre común, ingredientes, cantidad neta, nombre y dirección del negocio, y la fuente de cada alérgeno. La ley del condado ya lo exige."
            ]
        }
    ],
    quiz: {
        passThreshold: 0.85,
        questions: [
            {
                id: "fs2-q1",
                questionEn: "A guest with a peanut allergy orders a bowl. You grab tongs that were just in the crushed peanuts and touch the noodles. What now?",
                questionEs: "Un cliente con alergia al cacahuate pide un bowl. Usas unas pinzas que estaban en el cacahuate triturado y tocas los fideos. ¿Ahora qué?",
                options: [
                    { id: "a", textEn: "Pick out anything that looks like peanut", textEs: "Sacar lo que parezca cacahuate" },
                    { id: "b", textEn: "Throw it out, clean and sanitize, and remake it with clean tools", textEs: "Tirarlo, limpiar y sanitizar, y hacerlo de nuevo con herramientas limpias" },
                    { id: "c", textEn: "Serve it and tell the guest to eat carefully", textEs: "Servirlo y decirle al cliente que coma con cuidado" },
                    { id: "d", textEn: "Heat it up again so the peanut cooks away, then serve it as usual", textEs: "Calentarlo otra vez para que el cacahuate se cocine, y servirlo como siempre" }
                ],
                correct: "b"
            },
            {
                id: "fs2-q2",
                questionEn: "A guest asks if DD sauce has fish in it. You remember hearing that it doesn't. What do you say?",
                questionEs: "Un cliente pregunta si la salsa DD tiene pescado. Recuerdas haber oído que no. ¿Qué dices?",
                options: [
                    { id: "a", textEn: "\"No, it's fish-free.\"", textEs: "\"No, no tiene pescado.\"" },
                    { id: "b", textEn: "\"Probably not, but try a little first.\"", textEs: "\"Probablemente no, pero pruebe un poquito primero.\"" },
                    { id: "c", textEn: "\"Is this an allergy? Let me check before I answer.\"", textEs: "\"¿Es una alergia? Déjeme revisar antes de contestarle.\"" },
                    { id: "d", textEn: "\"You'd have to ask the kitchen yourself, I only run the register.\"", textEs: "\"Usted tendría que preguntarle a la cocina, yo solo atiendo la caja.\"" }
                ],
                correct: "c"
            },
            {
                id: "fs2-q3",
                questionEn: "You check for a guest with a sesame allergy. The matrix and the recipe tag don't agree on that sauce. What do you do?",
                questionEs: "Revisas por un cliente con alergia al ajonjolí. La matriz y la etiqueta de la receta no coinciden sobre esa salsa. ¿Qué haces?",
                options: [
                    { id: "a", textEn: "Go with the matrix, since it's newer and covers the finished dish, and serve it", textEs: "Hacerle caso a la matriz, porque es más nueva y cubre el platillo terminado, y servirlo" },
                    { id: "b", textEn: "Go with whichever one says it's safe", textEs: "Hacerle caso a la que diga que es seguro" },
                    { id: "c", textEn: "Take the sauce off and say nothing", textEs: "Quitar la salsa y no decir nada" },
                    { id: "d", textEn: "Get the person in charge and tell the guest you can't promise it", textEs: "Buscar a la persona a cargo y decirle al cliente que no puedes prometerlo" }
                ],
                correct: "d"
            },
            {
                id: "fs2-q4",
                questionEn: "Minutes after eating, a guest has hives and says her throat feels tight. What's first?",
                questionEs: "Minutos después de comer, una clienta tiene ronchas y dice que siente la garganta cerrada. ¿Qué es primero?",
                options: [
                    { id: "a", textEn: "Call emergency services and stay with her", textEs: "Llamar a los servicios de emergencia y quedarte con ella" },
                    { id: "b", textEn: "Offer her a glass of water and a refund", textEs: "Ofrecerle un vaso de agua y un reembolso" },
                    { id: "c", textEn: "Ask her to wait outside for fresh air", textEs: "Pedirle que espere afuera a tomar aire" },
                    { id: "d", textEn: "Look up the recipe first, then decide", textEs: "Buscar primero la receta y luego decidir" }
                ],
                correct: "a"
            },
            {
                id: "fs2-q5",
                questionEn: "A new hire lists the major allergens for you and stops at eight, leaving out sesame. How do you correct him?",
                questionEs: "Un empleado nuevo te dice los alérgenos principales y se detiene en ocho, sin el ajonjolí. ¿Cómo lo corriges?",
                options: [
                    { id: "a", textEn: "Don't. County law has eight, so that's enough", textEs: "No lo corriges. La ley del condado tiene ocho, así que basta" },
                    { id: "b", textEn: "We teach nine, and sesame is one of them", textEs: "Enseñamos nueve, y el ajonjolí es uno de ellos" },
                    { id: "c", textEn: "He should add coconut as the ninth", textEs: "Debería agregar el coco como el noveno" },
                    { id: "d", textEn: "He should add oysters as the ninth", textEs: "Debería agregar los ostiones como el noveno" }
                ],
                correct: "b"
            },
            {
                id: "fs2-q6",
                questionEn: "A guest says, \"I avoid coconut.\" A coworker says FDA doesn't count coconut as a tree nut anymore. What do you do?",
                questionEs: "Un cliente dice: \"Yo evito el coco.\" Un compañero dice que la FDA ya no cuenta el coco como nuez de árbol. ¿Qué haces?",
                options: [
                    { id: "a", textEn: "Tell the guest which items have coconut, the same as always", textEs: "Decirle al cliente qué platillos tienen coco, igual que siempre" },
                    { id: "b", textEn: "Say nothing, because coconut is no longer on FDA's list and it's not our job", textEs: "No decir nada, porque el coco ya no está en la lista de la FDA y no nos toca" },
                    { id: "c", textEn: "Tell the guest coconut can't hurt anyone", textEs: "Decirle al cliente que el coco no le hace daño a nadie" },
                    { id: "d", textEn: "Mark the order as a peanut allergy", textEs: "Marcar la orden como alergia al cacahuate" }
                ],
                correct: "a"
            },
            {
                id: "fs2-q7",
                questionEn: "A guest with a shrimp allergy asks about oyster sauce. Which answer is accurate?",
                questionEs: "Un cliente con alergia al camarón pregunta por la salsa de ostión. ¿Qué respuesta es correcta?",
                options: [
                    { id: "a", textEn: "Oysters are crustaceans, same as shrimp, so treat the sauce as one of the nine", textEs: "Los ostiones son crustáceos, igual que el camarón, así que la salsa es de las nueve" },
                    { id: "b", textEn: "It has no seafood in it at all", textEs: "No tiene nada de mariscos" },
                    { id: "c", textEn: "Oysters are mollusks, not one of the nine, but we still warn about the sauce", textEs: "Los ostiones son moluscos, no son de los nueve, pero igual avisamos de la salsa" },
                    { id: "d", textEn: "There's no need to mention it", textEs: "No hace falta mencionarla" }
                ],
                correct: "c"
            },
            {
                id: "fs2-q8",
                questionEn: "A manager wants to bottle a peanut sauce to sell at the counter. What must the label show?",
                questionEs: "Un gerente quiere embotellar una salsa de cacahuate para vender en el mostrador. ¿Qué debe llevar la etiqueta?",
                options: [
                    { id: "a", textEn: "The sauce name, the date made, the use-by date, the store's name and phone number, and a peanut warning", textEs: "El nombre de la salsa, la fecha, la fecha de uso, el nombre y teléfono de la tienda, y una advertencia de cacahuate" },
                    { id: "b", textEn: "Just a sticker saying \"contains nuts\"", textEs: "Solo una calcomanía que diga \"contiene nueces\"" },
                    { id: "c", textEn: "Nothing, if the guest can ask the cashier", textEs: "Nada, si el cliente le puede preguntar al cajero" },
                    { id: "d", textEn: "Common name, ingredients, net quantity, business name and address, and each allergen's source", textEs: "Nombre común, ingredientes, cantidad neta, nombre y dirección del negocio, y la fuente de cada alérgeno" }
                ],
                correct: "d"
            }
        ]
    }
};

export const FS3_DELIVERY_TO_STORAGE = {
    id: "fs3",
    code: "FS3",
    track: "food-safety",
    tier: "all",
    draft: true,
    icon: "🚚",
    durationMin: 25,
    titleEn: "From Delivery to Storage",
    titleEs: "De la Entrega al Almacén",
    lessons: [
        {
            id: "fs3-l1",
            titleEn: "Receiving a delivery",
            titleEs: "Recibir una entrega",
            contentEn: [
                "Check a delivery before you sign for it. TCS food means food that needs time and temperature control to stay safe, such as meat, cooked rice and noodles, cut greens and sprouts.",
                "| Item | Accept it when |",
                "| Cold TCS food, including sprouts | 41°F or below |",
                "| Hot TCS food | 135°F or above |",
                "| Frozen food | Frozen solid, no signs it thawed |",
                "| Shell eggs | Refrigerated at 45°F air or less |",
                "| Milk | Grade A pasteurized |",
                "## Send it back",
                "• Dirty, leaking or torn packaging",
                "• Dented, rusty or swollen cans",
                "• Signs of pests",
                "• Past its date",
                "• Frozen food that has thawed",
                "• The wrong temperature, smell or color",
                "Food must come from an approved, inspected source. Nothing made at someone's home, and no foraged wild mushrooms."
            ],
            contentEs: [
                "Revisa la entrega antes de firmar. Comida TCS significa comida que necesita control de tiempo y temperatura para mantenerse segura, como carne, arroz y fideos cocidos, verduras de hoja cortadas y germinados.",
                "| Producto | Acéptalo cuando |",
                "| Comida TCS fría, incluyendo germinados | 41°F o menos |",
                "| Comida TCS caliente | 135°F o más |",
                "| Comida congelada | Congelada sólida, sin señales de que se descongeló |",
                "| Huevos con cascarón | Refrigerados con aire a 45°F o menos |",
                "| Leche | Grado A pasteurizada |",
                "## Regrésalo",
                "• Empaque sucio, con fugas o roto",
                "• Latas abolladas, oxidadas o hinchadas",
                "• Señales de plagas",
                "• Fecha vencida",
                "• Comida congelada que se descongeló",
                "• Temperatura, olor o color incorrectos",
                "La comida debe venir de una fuente aprobada e inspeccionada. Nada hecho en casa de alguien, y nada de hongos silvestres recolectados."
            ]
        },
        {
            id: "fs3-l2",
            titleEn: "Storage order",
            titleEs: "Orden de almacenamiento",
            contentEn: [
                "Raw juices drip down. Keep the food that won't be cooked on top and the food that needs the most cooking on the bottom.",
                "| Shelf | What goes here |",
                "| Top | Ready-to-eat: cooked rice, sauces, cut herbs, spring roll fillings |",
                "| Next | Seafood |",
                "| Next | Whole beef and pork |",
                "| Next | Ground meat and ground seafood, such as ground pork |",
                "| Bottom | Poultry |",
                "Raw stays below ready-to-eat in the freezer too, even when it's packaged.",
                "## Storage rules",
                "• 6 inches off the floor, clean and dry",
                "• Never in restrooms, locker rooms, garbage rooms or mechanical rooms, or under leaks",
                "• Label working containers with the common name unless the food is unmistakable",
                "• Single-use containers are never reused",
                "• First in, first out, by use-by date",
                "• Recalled or damaged items go apart from everything else, with a label",
                "!! WEBSTER GROVES ONLY: A city rule on the books asks for frozen food at -10°F or lower. It's unconfirmed whether the city enforces it, so ask a manager."
            ],
            contentEs: [
                "Los jugos crudos gotean hacia abajo. Pon arriba la comida que no se va a cocinar y abajo la que necesita más cocción.",
                "| Repisa | Qué va aquí |",
                "| Arriba | Lista para comer: arroz cocido, salsas, hierbas cortadas, rellenos de spring roll |",
                "| Después | Pescados y mariscos |",
                "| Después | Res y puerco en piezas enteras |",
                "| Después | Carne y mariscos molidos, como el puerco molido |",
                "| Abajo | Pollo y aves |",
                "Lo crudo también va debajo de lo listo para comer en el congelador, aunque esté empacado.",
                "## Reglas de almacenamiento",
                "• A 6 pulgadas del piso, limpio y seco",
                "• Nunca en baños, vestidores, cuartos de basura o de máquinas, ni debajo de goteras",
                "• Etiqueta los contenedores de trabajo con el nombre común, a menos que la comida sea inconfundible",
                "• Los contenedores desechables nunca se reusan",
                "• Primero en entrar, primero en salir, según la fecha de uso",
                "• Lo retirado o dañado va aparte de todo lo demás, con etiqueta",
                "!! SOLO WEBSTER GROVES: Una regla de la ciudad pide comida congelada a -10°F o menos. No está confirmado si la ciudad la hace cumplir, así que pregúntale a un gerente."
            ]
        },
        {
            id: "fs3-l3",
            titleEn: "Thawing",
            titleEs: "Descongelar",
            contentEn: [
                "| Method | Rule |",
                "| Fridge | Food stays at 41°F or below |",
                "| Running water | Fully under water, 70°F or below, with enough force to float particles off. Raw food above 41°F for no more than 4 hours total. Ready-to-eat food stays at 41°F |",
                "| Cooking | Thaw as part of the cook |",
                "| Microwave | Move right away to regular cooking |",
                "| Counter | Never. It isn't a thawing method |",
                "!! DON'T REFREEZE: Once thawing starts, the food doesn't go back in the freezer at either store. Plan ahead for egg rolls and frozen seafood."
            ],
            contentEs: [
                "| Método | Regla |",
                "| Refrigerador | La comida se queda a 41°F o menos |",
                "| Agua corriendo | Totalmente bajo el agua, a 70°F o menos, con fuerza para que se lleve las partículas. Comida cruda arriba de 41°F no más de 4 horas en total. La comida lista para comer se queda a 41°F |",
                "| Cocción | Se descongela como parte de la cocción |",
                "| Microondas | Pásala de inmediato a cocción normal |",
                "| Mostrador | Nunca. No es un método para descongelar |",
                "!! NO VOLVER A CONGELAR: Una vez que empieza a descongelarse, la comida no regresa al congelador en ninguna de las dos tiendas. Planea con tiempo los egg rolls y los mariscos congelados."
            ]
        },
        {
            id: "fs3-l4",
            titleEn: "Date marking",
            titleEs: "Marcar fechas",
            contentEn: [
                "Ready-to-eat TCS food kept more than 24 hours needs a date. The limit is 7 days at 41°F, and prep day counts as Day 1. Your sticker may show a shorter life. Follow the sticker when it's shorter.",
                "| Made or opened | Gone by the end of |",
                "| Monday | Sunday |",
                "| Tuesday | Monday |",
                "| Friday | Thursday |",
                "## More date rules",
                "• Opened commercial food: opening day is Day 1. Never go past a safety date from the maker",
                "• Combined food keeps the earliest ingredient's date",
                "• Days in the freezer don't count",
                "• No date or past the date: throw it out",
                "• Cut lettuce, cabbage and other cut leafy greens are TCS, so they stay at 41°F with a date. Cut tomatoes too",
                "• Whole heads of lettuce and herbs like cilantro aren't on that list, but washed herbs still count as ready-to-eat"
            ],
            contentEs: [
                "La comida TCS lista para comer que se guarda más de 24 horas necesita fecha. El límite es 7 días a 41°F, y el día de preparación cuenta como Día 1. Tu etiqueta puede mostrar menos días. Sigue la etiqueta cuando sea más corta.",
                "| Hecho o abierto | Se termina al final del |",
                "| Lunes | Domingo |",
                "| Martes | Lunes |",
                "| Viernes | Jueves |",
                "## Más reglas de fechas",
                "• Comida comercial abierta: el día que se abre es el Día 1. Nunca pases una fecha de seguridad del fabricante",
                "• La comida combinada conserva la fecha del ingrediente más antiguo",
                "• Los días en el congelador no cuentan",
                "• Sin fecha o con fecha vencida: tírala",
                "• La lechuga, el repollo y otras verduras de hoja cortadas son TCS, así que van a 41°F con fecha. Los tomates cortados también",
                "• Las lechugas enteras y las hierbas como el cilantro no están en esa lista, pero las hierbas lavadas sí cuentan como listas para comer"
            ]
        },
        {
            id: "fs3-l5",
            titleEn: "Prep: keeping raw away from ready-to-eat",
            titleEs: "Preparación: lo crudo lejos de lo listo para comer",
            contentEn: [
                "| Change | What you do |",
                "| Raw food to ready-to-eat food | Clean and sanitize at each change |",
                "| One raw meat to another | Clean the equipment between them |",
                "| Scored cutting board | Resurface it or throw it out |",
                "Mixing raw pork in a prep sink is allowed only if the sink is cleaned and sanitized before and after, with nothing ready-to-eat in it until then. A tub is simpler.",
                "A dip or marinade that touched raw meat can't be kept for anything else. Keep different raw meats in separate marinades. If they get combined, they cook to the highest temperature, which is 165°F.",
                "Wash produce before you cut, combine or serve it, and keep it off surfaces that touched raw meat.",
                "Ice is food. Use a scoop, never your hands or a glass. Ice that cooled food or cans never goes in a drink."
            ],
            contentEs: [
                "| Cambio | Qué haces |",
                "| De comida cruda a lista para comer | Limpia y sanitiza en cada cambio |",
                "| De una carne cruda a otra | Limpia el equipo entre una y otra |",
                "| Tabla de cortar rayada | Repárala o tírala |",
                "Mezclar puerco crudo en un fregadero de preparación se permite solo si el fregadero se limpia y sanitiza antes y después, sin nada listo para comer ahí hasta entonces. Una tina es más sencillo.",
                "Una salsa o marinada que tocó carne cruda no se puede guardar para otra cosa. Mantén las carnes crudas distintas en marinadas separadas. Si se combinan, se cocinan a la temperatura más alta, que es 165°F.",
                "Lava las verduras antes de cortarlas, combinarlas o servirlas, y mantenlas fuera de superficies que tocaron carne cruda.",
                "El hielo es comida. Usa una pala, nunca las manos ni un vaso. El hielo que enfrió comida o latas nunca va en una bebida."
            ]
        }
    ],
    quiz: {
        passThreshold: 0.85,
        questions: [
            {
                id: "fs3-q1",
                questionEn: "The driver is in a hurry. A case of raw chicken probes at 50°F. What do you do?",
                questionEs: "El chofer tiene prisa. Una caja de pollo crudo marca 50°F con el termómetro. ¿Qué haces?",
                options: [
                    { id: "a", textEn: "Accept it and put it in the walk-in right away", textEs: "Aceptarla y meterla al walk-in de inmediato" },
                    { id: "b", textEn: "Accept it and cook it first today, since cooking takes care of the temperature", textEs: "Aceptarla y cocinarla primero hoy, porque la cocción arregla la temperatura" },
                    { id: "c", textEn: "Reject it, because cold TCS food must be 41°F or below", textEs: "Rechazarla, porque la comida TCS fría debe estar a 41°F o menos" },
                    { id: "d", textEn: "Freeze it to bring the temperature down", textEs: "Congelarla para bajar la temperatura" }
                ],
                correct: "c"
            },
            {
                id: "fs3-q2",
                questionEn: "A delivery of bean sprouts arrives warm, sitting outside the cold section of the truck. What's the right call?",
                questionEs: "Llega una entrega de germinados tibios, fuera de la parte fría del camión. ¿Qué es lo correcto?",
                options: [
                    { id: "a", textEn: "Sprouts are TCS and must arrive at 41°F or below, so send them back", textEs: "Los germinados son TCS y deben llegar a 41°F o menos, así que regrésalos" },
                    { id: "b", textEn: "Sprouts are a garnish, so temperature doesn't matter", textEs: "Los germinados son decoración, así que la temperatura no importa" },
                    { id: "c", textEn: "Rinse them in cold water and keep them", textEs: "Enjuagarlos con agua fría y quedártelos" },
                    { id: "d", textEn: "Accept them if they look crisp and smell fresh, since sprouts only need a quick rinse", textEs: "Aceptarlos si se ven crujientes y huelen frescos, porque solo necesitan una enjuagada" }
                ],
                correct: "a"
            },
            {
                id: "fs3-q3",
                questionEn: "A case of frozen shrimp has ice stuck in clumps and liquid stains on the box. What do you do?",
                questionEs: "Una caja de camarón congelado tiene hielo pegado en bloques y manchas de líquido. ¿Qué haces?",
                options: [
                    { id: "a", textEn: "Accept it, since it's still cold", textEs: "Aceptarla, porque sigue fría" },
                    { id: "b", textEn: "Accept it and refreeze it deeper in the freezer", textEs: "Aceptarla y volver a congelarla al fondo" },
                    { id: "c", textEn: "Use it today for spring rolls", textEs: "Usarlo hoy para spring rolls" },
                    { id: "d", textEn: "Reject it for signs of thawing and refreezing", textEs: "Rechazarla por señales de descongelarse y volver a congelarse" }
                ],
                correct: "d"
            },
            {
                id: "fs3-q4",
                questionEn: "You're stocking the walk-in. Which item goes on the bottom shelf?",
                questionEs: "Estás acomodando el walk-in. ¿Qué va en la repisa de abajo?",
                options: [
                    { id: "a", textEn: "Raw chicken", textEs: "Pollo crudo" },
                    { id: "b", textEn: "Raw shrimp", textEs: "Camarón crudo" },
                    { id: "c", textEn: "Whole beef for pho", textEs: "Res entera para pho" },
                    { id: "d", textEn: "Cooked rice", textEs: "Arroz cocido" }
                ],
                correct: "a"
            },
            {
                id: "fs3-q5",
                questionEn: "The freezer is full. Someone stacks boxed raw pork on top of frozen spring roll fillings because \"it's all sealed.\" Is that OK?",
                questionEs: "El congelador está lleno. Alguien pone cajas de puerco crudo encima de rellenos congelados de spring roll porque \"todo está sellado.\" ¿Está bien?",
                options: [
                    { id: "a", textEn: "Yes, frozen packaged food can't drip, so the order doesn't matter in a freezer", textEs: "Sí, lo congelado y empacado no gotea, así que el orden no importa en el congelador" },
                    { id: "b", textEn: "No, raw stays below ready-to-eat in freezers too", textEs: "No, lo crudo también va debajo de lo listo para comer en el congelador" },
                    { id: "c", textEn: "Yes, as long as it's under a day", textEs: "Sí, mientras sea menos de un día" },
                    { id: "d", textEn: "Yes, if the boxes are labeled", textEs: "Sí, si las cajas tienen etiqueta" }
                ],
                correct: "b"
            },
            {
                id: "fs3-q6",
                questionEn: "You need frozen pork thawed by this afternoon. Which plan works?",
                questionEs: "Necesitas el puerco congelado descongelado para esta tarde. ¿Qué plan funciona?",
                options: [
                    { id: "a", textEn: "Leave it on the counter under a towel", textEs: "Dejarlo en el mostrador bajo un trapo" },
                    { id: "b", textEn: "Put it in a pan of warm water and change the water when it gets cold", textEs: "Ponerlo en una charola con agua tibia y cambiar el agua cuando se enfríe" },
                    { id: "c", textEn: "Fully under running water at 70°F or below", textEs: "Totalmente bajo agua corriendo a 70°F o menos" },
                    { id: "d", textEn: "Set it on top of the pho pot", textEs: "Ponerlo encima de la olla de pho" }
                ],
                correct: "c"
            },
            {
                id: "fs3-q7",
                questionEn: "A tub of house sauce was made Monday with no shorter life on its sticker. When's the last day it can be used?",
                questionEs: "Una tina de salsa de la casa se hizo el lunes y su etiqueta no indica menos días. ¿Cuál es el último día que se puede usar?",
                options: [
                    { id: "a", textEn: "The next Monday, 7 full days later", textEs: "El lunes siguiente, 7 días completos después" },
                    { id: "b", textEn: "Sunday, because Monday counts as Day 1", textEs: "El domingo, porque el lunes cuenta como Día 1" },
                    { id: "c", textEn: "Whenever it starts to smell off", textEs: "Cuando empiece a oler mal" },
                    { id: "d", textEn: "Thursday, because all sauces get 3 days", textEs: "El jueves, porque todas las salsas tienen 3 días" }
                ],
                correct: "b"
            },
            {
                id: "fs3-q8",
                questionEn: "You top off a fresh Wednesday batch of sauce with what's left of Monday's batch. What date does the tub get?",
                questionEs: "Mezclas una tanda fresca de salsa del miércoles con lo que quedó de la tanda del lunes. ¿Qué fecha lleva la tina?",
                options: [
                    { id: "a", textEn: "Wednesday, because most of what's in the tub was made that day", textEs: "Miércoles, porque casi todo lo que hay en la tina se hizo ese día" },
                    { id: "b", textEn: "Tuesday, the middle date", textEs: "Martes, la fecha de en medio" },
                    { id: "c", textEn: "No date is needed once mixed", textEs: "No necesita fecha una vez mezclada" },
                    { id: "d", textEn: "Monday, the earliest ingredient's date", textEs: "Lunes, la fecha del ingrediente más antiguo" }
                ],
                correct: "d"
            },
            {
                id: "fs3-q9",
                questionEn: "You find a tub of cut cabbage in the reach-in with no date on it. Nobody remembers when it was cut. What do you do?",
                questionEs: "Encuentras una tina de repollo cortado en el refrigerador sin fecha. Nadie recuerda cuándo se cortó. ¿Qué haces?",
                options: [
                    { id: "a", textEn: "Throw it out", textEs: "Tirarla" },
                    { id: "b", textEn: "Date it with today's date", textEs: "Ponerle la fecha de hoy" },
                    { id: "c", textEn: "Use it first, before anything else", textEs: "Usarla primero, antes que lo demás" },
                    { id: "d", textEn: "Smell it and decide", textEs: "Olerla y decidir" }
                ],
                correct: "a"
            },
            {
                id: "fs3-q10",
                questionEn: "A bag of frozen fish thawed in the walk-in, and the order got canceled. Can it go back in the freezer?",
                questionEs: "Una bolsa de pescado congelado se descongeló en el walk-in y cancelaron la orden. ¿Puede regresar al congelador?",
                options: [
                    { id: "a", textEn: "Yes, if it's still cold", textEs: "Sí, si sigue fría" },
                    { id: "b", textEn: "Yes, at the Maryland Heights store only", textEs: "Sí, solo en la tienda de Maryland Heights" },
                    { id: "c", textEn: "No. We don't refreeze once thawing starts", textEs: "No. No volvemos a congelar una vez que empieza a descongelarse" },
                    { id: "d", textEn: "Yes, if you write a new date and put it at the back of the freezer", textEs: "Sí, si le escribes una fecha nueva y la pones al fondo del congelador" }
                ],
                correct: "c"
            }
        ]
    }
};

export const FS4_COOKING = {
    id: "fs4",
    code: "FS4",
    track: "food-safety",
    tier: "all",
    draft: true,
    icon: "🌡️",
    durationMin: 25,
    titleEn: "Cooking and Temperatures",
    titleEs: "Cocción y Temperaturas",
    lessons: [
        {
            id: "fs4-l1",
            titleEn: "Cook temperatures",
            titleEs: "Temperaturas de cocción",
            contentEn: [
                "Heat every part of the food, and read the temperature in the thickest part. If it hasn't reached the number, keep cooking until it does.",
                "| Food | Cook to |",
                "| Chicken and other poultry | 165°F for 15 seconds |",
                "| Stuffed meat or fish | 165°F for 15 seconds |",
                "| Dishes with previously cooked TCS ingredients | 165°F for 15 seconds |",
                "| Ground meat, ground fish, injected meat | 155°F for 17 seconds |",
                "| Pounded, cubed or tumbled meat | 155°F for 17 seconds |",
                "| Eggs for hot holding, pooled eggs | 155°F for 17 seconds |",
                "| Egg for a guest's order, served right away | 145°F for 15 seconds |",
                "| Fish, whole steaks and chops | 145°F for 15 seconds |",
                "| Whole roasts | 145°F for 4 minutes |",
                "| Vegetables, rice and noodles for hot holding | 135°F |",
                "| Raw animal food in a microwave | 165°F in all parts. Stir or rotate, cover, stand 2 minutes |",
                "If a package has cooking directions, follow them.",
                "!! EXAM NOTE: The ServSafe exam answer for chicken and for dishes with cooked ingredients is 165°F for under 1 second. County law for chicken says 15 seconds, so we hold 15 seconds."
            ],
            contentEs: [
                "Calienta todas las partes de la comida y mide la temperatura en la parte más gruesa. Si no ha llegado al número, sigue cocinando hasta que llegue.",
                "| Comida | Cocinar a |",
                "| Pollo y otras aves | 165°F por 15 segundos |",
                "| Carne o pescado relleno | 165°F por 15 segundos |",
                "| Platillos con ingredientes TCS ya cocidos | 165°F por 15 segundos |",
                "| Carne molida, pescado molido, carne inyectada | 155°F por 17 segundos |",
                "| Carne aplanada, en cubos o masajeada | 155°F por 17 segundos |",
                "| Huevos para mantener calientes, huevos mezclados | 155°F por 17 segundos |",
                "| Huevo para la orden de un cliente, servido de inmediato | 145°F por 15 segundos |",
                "| Pescado, bistecs y chuletas enteros | 145°F por 15 segundos |",
                "| Asados enteros | 145°F por 4 minutos |",
                "| Verduras, arroz y fideos para mantener calientes | 135°F |",
                "| Comida animal cruda en microondas | 165°F en todas las partes. Mueve o gira, tapa, deja reposar 2 minutos |",
                "Si un paquete trae instrucciones de cocción, síguelas.",
                "!! NOTA DE EXAMEN: La respuesta del examen ServSafe para el pollo y para platillos con ingredientes cocidos es 165°F por menos de 1 segundo. La ley del condado para el pollo dice 15 segundos, así que mantenemos 15 segundos."
            ]
        },
        {
            id: "fs4-l2",
            titleEn: "Our dishes",
            titleEs: "Nuestros platillos",
            contentEn: [
                "| Dish | Target | Why |",
                "| Egg rolls with raw pork | 165°F for 15 seconds | The county hasn't said if an egg roll counts as stuffed. Ground pork alone would be 155°F, so we use the higher number |",
                "| Fried rice | 165°F for 15 seconds | It's made to order from rice cooked earlier. Any raw egg or meat added also needs its own temperature |",
                "| Mixed meats | 165°F for 15 seconds | Mixed meats cook to the highest temperature of any meat in them |",
                "| Lemongrass chicken | 165°F for 15 seconds | It's poultry, so the poultry rule applies |",
                "| Whole-muscle pork or beef | 145°F for 15 seconds | Whole-muscle meat, as long as it hasn't been injected or tenderized |",
                "Check bought meat for pre-tenderized labels. Injected or deep-tenderized meat moves up to the 155°F row.",
                "!! COOKING IN STAGES: Partly cooking food now and finishing later is something the county doesn't name. Each stage still has to meet the limits. Ask a manager before you set up a new par-cook step."
            ],
            contentEs: [
                "| Platillo | Meta | Por qué |",
                "| Egg rolls con puerco crudo | 165°F por 15 segundos | El condado no ha dicho si un egg roll cuenta como relleno. El puerco molido solo sería 155°F, así que usamos el número más alto |",
                "| Arroz frito | 165°F por 15 segundos | Se hace al momento con arroz cocido antes. Cualquier huevo o carne cruda que se agregue también necesita su propia temperatura |",
                "| Carnes mezcladas | 165°F por 15 segundos | Las carnes mezcladas se cocinan a la temperatura más alta de cualquier carne que lleven |",
                "| Pollo con limoncillo | 165°F por 15 segundos | Es ave, así que aplica la regla de aves |",
                "| Puerco o res de pieza entera | 145°F por 15 segundos | Carne de pieza entera, siempre que no esté inyectada ni ablandada |",
                "Revisa en la carne comprada si la etiqueta dice que está ablandada. La carne inyectada o ablandada a fondo sube a la fila de 155°F.",
                "!! COCINAR POR ETAPAS: Cocinar parcialmente ahora y terminar después es algo que el condado no menciona. Cada etapa debe cumplir los límites. Pregúntale a un gerente antes de armar un nuevo paso de precocción."
            ]
        },
        {
            id: "fs4-l3",
            titleEn: "Raw and undercooked food, and advisories",
            titleEs: "Comida cruda o poco cocida, y avisos",
            contentEn: [
                "A consumer advisory is the written menu note, usually an asterisk, that an item is raw or undercooked and carries more risk.",
                "## What it takes",
                "• A disclosure that marks the item, such as an asterisk",
                "• A written reminder that names the risk of eating raw or undercooked meats, poultry, seafood, shellfish or eggs",
                "• On every guest-facing menu: print, boards, online, third-party apps and catering",
                "## Where it applies",
                "| Item | Rule |",
                "| Any pho with rare steak | Needs the asterisk everywhere it's listed |",
                "| An egg with a runny yolk | Under 145°F means it's undercooked, so it needs the advisory |",
                "| Sauce made from uncooked yolks | Use pasteurized eggs. Read the label. If you can't confirm, tell a manager |",
                "Rare beef counts as ready-to-eat, so the bare-hand ban and date marks apply when you slice and plate it.",
                "## Who can't have it",
                "Nursing homes, hospitals and day cares can't get raw or partly cooked animal food or raw seed sprouts, and eggs must be pasteurized. For a catering order, ask if it's going to one of these places, and tell a manager if it is."
            ],
            contentEs: [
                "Un aviso al consumidor es la nota escrita en el menú, normalmente un asterisco, de que un platillo está crudo o poco cocido y tiene más riesgo.",
                "## Qué se necesita",
                "• Una marca que señale el platillo, como un asterisco",
                "• Un recordatorio escrito que nombre el riesgo de comer carnes, aves, mariscos, moluscos o huevos crudos o poco cocidos",
                "• En todos los menús para clientes: impresos, pizarrones, en línea, aplicaciones de terceros y catering",
                "## Dónde aplica",
                "| Platillo | Regla |",
                "| Cualquier pho con res rara | Necesita el asterisco en todos los lugares donde aparece |",
                "| Un huevo con yema líquida | Abajo de 145°F está poco cocido, así que necesita el aviso |",
                "| Salsa hecha con yemas sin cocer | Usa huevos pasteurizados. Lee la etiqueta. Si no puedes confirmar, avísale a un gerente |",
                "La res rara cuenta como lista para comer, así que la prohibición de manos sin guantes y las fechas aplican al rebanarla y servirla.",
                "## Quién no puede recibirla",
                "Los asilos, hospitales y guarderías no pueden recibir comida animal cruda o parcialmente cocida ni germinados crudos, y los huevos deben ser pasteurizados. En una orden de catering, pregunta si va a uno de estos lugares y avísale a un gerente si es así."
            ]
        },
        {
            id: "fs4-l4",
            titleEn: "Thermometers",
            titleEs: "Termómetros",
            contentEn: [
                "A number you didn't measure isn't a number. Use a thermometer.",
                "| Rule | What it means |",
                "| Accuracy for food | Within ±2°F |",
                "| Accuracy for air and water | Within ±3°F |",
                "| Thin foods | Use a thin probe, such as for thin-sliced meat |",
                "| Units | Thermometer in the warmest part of a cooler, the coolest part of a hot unit |",
                "| Check it | Follow the maker's steps. The ice water method reads 32°F |",
                "| Clean | Clean and sanitize it before using or storing it |",
                "Don't trust a unit's outside gauge. The county's own guidance says to check with a thermometer and write it down.",
                "Glass thermometers aren't allowed in food unless they have a shatterproof coating."
            ],
            contentEs: [
                "Un número que no mediste no es un número. Usa un termómetro.",
                "| Regla | Qué significa |",
                "| Precisión para comida | Dentro de ±2°F |",
                "| Precisión para aire y agua | Dentro de ±3°F |",
                "| Comidas delgadas | Usa una sonda delgada, como para carne en rebanadas finas |",
                "| Equipos | Termómetro en la parte más caliente del refrigerador y en la más fría de un equipo caliente |",
                "| Revisarlo | Sigue los pasos del fabricante. El método de agua con hielo marca 32°F |",
                "| Limpieza | Límpialo y sanitízalo antes de usarlo o guardarlo |",
                "No confíes en el marcador de afuera del equipo. La guía del propio condado dice que revises con termómetro y lo anotes.",
                "Los termómetros de vidrio no se permiten en comida a menos que tengan una cubierta inastillable."
            ]
        }
    ],
    quiz: {
        passThreshold: 0.85,
        questions: [
            {
                id: "fs4-q1",
                questionEn: "You probe a chicken thigh on the grill and it just touched 165°F. Can you pull it?",
                questionEs: "Mides un muslo de pollo en la plancha y acaba de llegar a 165°F. ¿Puedes sacarlo?",
                options: [
                    { id: "a", textEn: "Yes, the moment it hits 165°F", textEs: "Sí, en cuanto llega a 165°F" },
                    { id: "b", textEn: "Not yet. Our rule is 165°F held for 15 seconds", textEs: "Todavía no. Nuestra regla es 165°F por 15 segundos" },
                    { id: "c", textEn: "No, chicken needs 4 minutes at 165°F", textEs: "No, el pollo necesita 4 minutos a 165°F" },
                    { id: "d", textEn: "Yes, if the juices look clear and the outside has good color on it", textEs: "Sí, si los jugos se ven claros y por fuera tiene buen color" }
                ],
                correct: "b"
            },
            {
                id: "fs4-q2",
                questionEn: "During a rush, a batch of chicken reads 155°F. The tickets are stacking up. What do you do?",
                questionEs: "En plena hora pico, una tanda de pollo marca 155°F. Los tickets se están juntando. ¿Qué haces?",
                options: [
                    { id: "a", textEn: "Send it, since 155°F is close enough", textEs: "Mandarlo, porque 155°F está cerca" },
                    { id: "b", textEn: "Send it and let the hot bowl finish it, since rush tickets can't wait", textEs: "Mandarlo y que el bowl caliente lo termine, porque los tickets no pueden esperar" },
                    { id: "c", textEn: "Throw it out and start over", textEs: "Tirarlo y empezar de nuevo" },
                    { id: "d", textEn: "Keep cooking until it reaches 165°F for 15 seconds", textEs: "Seguir cocinando hasta 165°F por 15 segundos" }
                ],
                correct: "d"
            },
            {
                id: "fs4-q3",
                questionEn: "A new fry cook asks what temperature our raw pork egg rolls must reach. What do you tell him?",
                questionEs: "Un cocinero nuevo pregunta a qué temperatura deben llegar nuestros egg rolls de puerco crudo. ¿Qué le dices?",
                options: [
                    { id: "a", textEn: "135°F, the same as hot holding", textEs: "135°F, igual que mantener caliente" },
                    { id: "b", textEn: "145°F for 15 seconds, the same as pork chops and other whole cuts of pork", textEs: "145°F por 15 segundos, igual que las chuletas y otras piezas enteras de puerco" },
                    { id: "c", textEn: "165°F for 15 seconds, until the county says otherwise", textEs: "165°F por 15 segundos, hasta que el condado diga otra cosa" },
                    { id: "d", textEn: "Golden brown is the only test", textEs: "Dorado es la única prueba" }
                ],
                correct: "c"
            },
            {
                id: "fs4-q4",
                questionEn: "You're making fried rice to order with rice cooked earlier and already-cooked chicken. What's the target?",
                questionEs: "Haces arroz frito al momento con arroz cocido antes y pollo ya cocido. ¿Cuál es la meta?",
                options: [
                    { id: "a", textEn: "165°F for 15 seconds", textEs: "165°F por 15 segundos" },
                    { id: "b", textEn: "135°F, since everything is already cooked", textEs: "135°F, porque todo ya está cocido" },
                    { id: "c", textEn: "Any temperature, if it's hot to the touch", textEs: "Cualquier temperatura, si se siente caliente" },
                    { id: "d", textEn: "145°F for 4 minutes", textEs: "145°F por 4 minutos" }
                ],
                correct: "a"
            },
            {
                id: "fs4-q5",
                questionEn: "A guest orders an egg over easy on a bowl, and the yolk is runny. What has to be true?",
                questionEs: "Un cliente pide un huevo volteado en un bowl y la yema queda líquida. ¿Qué tiene que cumplirse?",
                options: [
                    { id: "a", textEn: "Nothing, because eggs are always low-risk", textEs: "Nada, porque los huevos siempre son de bajo riesgo" },
                    { id: "b", textEn: "It has to be cooked to 135°F", textEs: "Tiene que cocinarse a 135°F" },
                    { id: "c", textEn: "The guest has to sign a form saying they know about the risk of the egg", textEs: "El cliente tiene que firmar un formulario diciendo que conoce el riesgo del huevo" },
                    { id: "d", textEn: "The menu must carry the consumer advisory for that egg", textEs: "El menú debe llevar el aviso al consumidor para ese huevo" }
                ],
                correct: "d"
            },
            {
                id: "fs4-q6",
                questionEn: "You notice a third-party delivery app lists a pho with rare steak, but there's no asterisk or note. What do you do?",
                questionEs: "Notas que una aplicación de entregas muestra un pho con res rara, pero sin asterisco ni nota. ¿Qué haces?",
                options: [
                    { id: "a", textEn: "Nothing, since the advisory rule only covers the printed menus in the store", textEs: "Nada, porque la regla del aviso solo cubre los menús impresos de la tienda" },
                    { id: "b", textEn: "Tell a manager, because every guest-facing menu needs it", textEs: "Avisarle a un gerente, porque todos los menús para clientes lo necesitan" },
                    { id: "c", textEn: "Tell the driver to warn the guest", textEs: "Decirle al chofer que le avise al cliente" },
                    { id: "d", textEn: "Cook the steak longer on delivery orders", textEs: "Cocinar más la res en las órdenes de entrega" }
                ],
                correct: "b"
            },
            {
                id: "fs4-q7",
                questionEn: "A nursing home places a catering order and asks for pho with rare steak and raw sprouts on the side. What do you do?",
                questionEs: "Un asilo hace una orden de catering y pide pho con res rara y germinados crudos aparte. ¿Qué haces?",
                options: [
                    { id: "a", textEn: "Tell a manager. That group can't get raw animal food or raw sprouts", textEs: "Avisarle a un gerente. Ese grupo no puede recibir comida animal cruda ni germinados crudos" },
                    { id: "b", textEn: "Send it with an asterisk on the bag, since the guest has been told about the risk", textEs: "Mandarlo con un asterisco en la bolsa, porque ya se le avisó del riesgo al cliente" },
                    { id: "c", textEn: "Send it, since the customer asked for it", textEs: "Mandarlo, porque el cliente lo pidió" },
                    { id: "d", textEn: "Send it, as long as it stays at 41°F", textEs: "Mandarlo, siempre que se mantenga a 41°F" }
                ],
                correct: "a"
            },
            {
                id: "fs4-q8",
                questionEn: "A prep cook makes mayo from yolks with no cook step and can't tell if the yolks are pasteurized. What's next?",
                questionEs: "Un cocinero hace mayonesa con yemas sin cocer y no sabe si las yemas son pasteurizadas. ¿Qué sigue?",
                options: [
                    { id: "a", textEn: "Make it, because the acid in the sauce makes raw yolks safe to serve", textEs: "Hacerla, porque el ácido de la salsa vuelve seguras las yemas crudas" },
                    { id: "b", textEn: "Make it and use it the same day", textEs: "Hacerla y usarla el mismo día" },
                    { id: "c", textEn: "Read the label and tell a manager if you can't confirm it", textEs: "Leer la etiqueta y avisarle a un gerente si no puedes confirmarlo" },
                    { id: "d", textEn: "Add more salt to the batch", textEs: "Agregarle más sal a la tanda" }
                ],
                correct: "c"
            },
            {
                id: "fs4-q9",
                questionEn: "You want to read the temperature of thin-sliced pork in a pan. Which tool is right?",
                questionEs: "Quieres medir la temperatura de puerco en rebanadas finas en un sartén. ¿Qué herramienta es la correcta?",
                options: [
                    { id: "a", textEn: "The thermometer on the walk-in door", textEs: "El termómetro de la puerta del walk-in" },
                    { id: "b", textEn: "Your finger, if you're quick", textEs: "Tu dedo, si eres rápido" },
                    { id: "c", textEn: "A glass thermometer from home, as long as it reads accurately", textEs: "Un termómetro de vidrio de tu casa, siempre que mida bien" },
                    { id: "d", textEn: "A thin probe, cleaned and sanitized first", textEs: "Una sonda delgada, limpia y sanitizada primero" }
                ],
                correct: "d"
            }
        ]
    }
};

export const FS5_COOLING_HOLDING = {
    id: "fs5",
    code: "FS5",
    track: "food-safety",
    tier: "all",
    draft: true,
    icon: "❄️",
    durationMin: 30,
    titleEn: "Cooling, Reheating and Holding",
    titleEs: "Enfriar, Recalentar y Mantener",
    lessons: [
        {
            id: "fs5-l1",
            titleEn: "Cooling in two stages",
            titleEs: "Enfriar en dos etapas",
            contentEn: [
                "Cooked food has to get through the warm range fast. Germs grow fastest between 70°F and 125°F.",
                "| Stage | Limit |",
                "| 1 | From 135°F down to 70°F within 2 hours |",
                "| 2 | From 70°F down to 41°F within 4 more hours, never past 6 hours total |",
                "| Food made from room-temperature ingredients | 41°F within 4 hours |",
                "The code itself says 6 hours total. The 4-hour second stage comes from the county's own cooling sheet and plan form. It's the stricter choice, so we teach it. A sticker that prints the 6-hour total shows the outer limit, not a goal.",
                "## How to cool",
                "• Shallow pans, food no more than 2 inches deep, no stacking",
                "• Split big batches into smaller containers",
                "• Stir in an ice bath, or use rapid cooling equipment",
                "• Add ice as an ingredient when the recipe allows it",
                "• Leave it loosely covered or uncovered, if it's protected",
                "• Probe it and write down the temperature and time",
                "A big pot of pho broth can't reach 70°F in 2 hours on its own, and that's especially true at 100 or 200 quarts. If broth is ever cooled, it has to be divided or chilled.",
                "!! MISSED A LIMIT: Store rule: throw it out. Don't guess. If a cooled pan reads above 41°F when you check it, it goes in the trash."
            ],
            contentEs: [
                "La comida cocida tiene que pasar rápido por el rango tibio. Los gérmenes crecen más rápido entre 70°F y 125°F.",
                "| Etapa | Límite |",
                "| 1 | De 135°F a 70°F en 2 horas o menos |",
                "| 2 | De 70°F a 41°F en 4 horas más, nunca más de 6 horas en total |",
                "| Comida hecha con ingredientes a temperatura ambiente | 41°F en 4 horas o menos |",
                "El código dice 6 horas en total. La segunda etapa de 4 horas viene de la hoja de enfriamiento y del formulario de planos del propio condado. Es la opción más estricta, y por eso la enseñamos. Una etiqueta que imprime el total de 6 horas muestra el límite máximo, no una meta.",
                "## Cómo enfriar",
                "• Charolas bajas, comida con no más de 2 pulgadas de profundidad, sin apilar",
                "• Divide las tandas grandes en contenedores más chicos",
                "• Mueve en baño de hielo, o usa equipo de enfriamiento rápido",
                "• Agrega hielo como ingrediente si la receta lo permite",
                "• Déjala tapada sin apretar o destapada, si está protegida",
                "• Mídela con el termómetro y anota la temperatura y la hora",
                "Una olla grande de caldo de pho no llega a 70°F en 2 horas por sí sola, sobre todo con 100 o 200 cuartos. Si alguna vez se enfría caldo, hay que dividirlo o enfriarlo con equipo.",
                "!! SE PASÓ DEL LÍMITE: Regla de la tienda: tírala. No adivines. Si una charola enfriada marca más de 41°F cuando la revisas, va a la basura."
            ]
        },
        {
            id: "fs5-l2",
            titleEn: "Reheating",
            titleEs: "Recalentar",
            contentEn: [
                "| Situation | Rule |",
                "| Reheating to hold hot | 165°F for 15 seconds, within 2 hours |",
                "| Microwave | 165°F, rotate, cover, stand 2 minutes |",
                "| Sealed ready-to-eat food from a plant | 135°F |",
                "| A guest's order, served right away | Any temperature, if it was cooked and cooled correctly |",
                "!! NOT IN THE STEAM TABLE: Never reheat in a hot-holding unit. Heat the food on a burner or in a kettle, then move it to the unit. That goes for pho broth too. A hot-holding unit keeps food hot. It doesn't bring it back up."
            ],
            contentEs: [
                "| Situación | Regla |",
                "| Recalentar para mantener caliente | 165°F por 15 segundos, en 2 horas o menos |",
                "| Microondas | 165°F, gira, tapa, deja reposar 2 minutos |",
                "| Comida lista para comer sellada de fábrica | 135°F |",
                "| La orden de un cliente, servida de inmediato | Cualquier temperatura, si se cocinó y enfrió correctamente |",
                "!! NO EN LA MESA CALIENTE: Nunca recalientes en un equipo para mantener caliente. Calienta la comida en la estufa o en una olla, y luego pásala al equipo. Lo mismo para el caldo de pho. El equipo mantiene caliente la comida. No la vuelve a subir."
            ]
        },
        {
            id: "fs5-l3",
            titleEn: "Holding hot and cold",
            titleEs: "Mantener caliente y frío",
            contentEn: [
                "| Food | Hold at |",
                "| Hot food | 135°F or above |",
                "| Whole roasts | 130°F or above |",
                "| Cold food | 41°F or below |",
                "| Raw shell eggs | Stored in 45°F air or below |",
                "Between 41°F and 135°F is the danger zone. If you've seen 45°F or 140°F on an older sheet, use 41°F and 135°F.",
                "!! 4 HOURS ISN'T PERMISSION: \"Toss after 4 hours in the danger zone\" is a throw-out limit. Outside written time control or active cooling, TCS food between 41°F and 135°F already breaks the holding rule, and an inspector can cite it before 4 hours.",
                "## Checks",
                "Store choice: check holding temperatures every 2 hours during service with a thermometer, and write them down. That leaves time to fix a problem. The exam says at least every 4 hours.",
                "## The warmer",
                "\"Hold warm\" isn't a temperature. Fried egg rolls in a warmer have two legal options: 135°F or above, or written time control with a 4-hour mark. Nothing in between counts. Measure it."
            ],
            contentEs: [
                "| Comida | Mantener a |",
                "| Comida caliente | 135°F o más |",
                "| Asados enteros | 130°F o más |",
                "| Comida fría | 41°F o menos |",
                "| Huevos crudos con cascarón | Guardados con aire a 45°F o menos |",
                "Entre 41°F y 135°F está la zona de peligro. Si has visto 45°F o 140°F en una hoja más vieja, usa 41°F y 135°F.",
                "!! 4 HORAS NO ES PERMISO: \"Tirar después de 4 horas en la zona de peligro\" es un límite para tirar. Fuera de un control de tiempo escrito o de un enfriamiento activo, la comida TCS entre 41°F y 135°F ya rompe la regla, y un inspector puede citarla antes de las 4 horas.",
                "## Revisiones",
                "Decisión de la tienda: revisa las temperaturas cada 2 horas durante el servicio con un termómetro, y anótalas. Eso deja tiempo para arreglar un problema. El examen dice por lo menos cada 4 horas.",
                "## El calentador",
                "\"Mantener tibio\" no es una temperatura. Los egg rolls fritos en un calentador tienen dos opciones legales: 135°F o más, o control de tiempo escrito con una marca de 4 horas. Nada en medio cuenta. Mídelo."
            ]
        },
        {
            id: "fs5-l4",
            titleEn: "Time as a control",
            titleEs: "El tiempo como control",
            contentEn: [
                "Time as a control means holding food outside temperature limits under a written procedure, with a marked throw-out time. The procedure must be written in advance, kept in the store and shown on request. If it isn't in the store, you can't use time. Ask a manager where it is.",
                "| Item | 4-hour route | 6-hour route |",
                "| Starts at | 41°F or below, or 135°F or above | 41°F or below |",
                "| Mark it with | A time 4 hours out | The removal time and the 6-hour time |",
                "| During | Watch the clock | Never above 70°F. Watch the warmest part |",
                "| At the limit | Served or tossed | Served or tossed. Toss earlier if it passes 70°F |",
                "The clock starts when the food comes out of temperature control, not when it reaches the line.",
                "No mark, or a mark that's later than the limit, means toss.",
                "!! EXAM NOTE: The ServSafe exam allows cut produce and opened sealed food to start at 70°F or below on a 4-hour limit. County rule: 41°F or 135°F only, so that's what we do.",
                "The 2005 wording is narrower than the newer one: a working supply before cooking, or ready-to-eat food held for service for immediate consumption. We're teaching the narrow version until the county answers."
            ],
            contentEs: [
                "El tiempo como control significa mantener comida fuera de los límites de temperatura bajo un procedimiento escrito, con una hora marcada para tirarla. El procedimiento debe escribirse por adelantado, estar en la tienda y mostrarse si lo piden. Si no está en la tienda, no puedes usar tiempo. Pregúntale a un gerente dónde está.",
                "| Tema | Ruta de 4 horas | Ruta de 6 horas |",
                "| Empieza a | 41°F o menos, o 135°F o más | 41°F o menos |",
                "| Márcala con | Una hora 4 horas después | La hora de salida y la hora de las 6 horas |",
                "| Durante | Vigila el reloj | Nunca arriba de 70°F. Vigila la parte más caliente |",
                "| Al llegar al límite | Servida o tirada | Servida o tirada. Tírala antes si pasa de 70°F |",
                "El reloj empieza cuando la comida sale del control de temperatura, no cuando llega a la línea.",
                "Sin marca, o con una marca más tarde del límite, se tira.",
                "!! NOTA DE EXAMEN: El examen ServSafe permite que las verduras cortadas y la comida sellada abierta empiecen a 70°F o menos con un límite de 4 horas. Regla del condado: 41°F o 135°F solamente, y eso es lo que hacemos.",
                "El texto de 2005 es más limitado que el nuevo: un suministro de trabajo antes de cocinar, o comida lista para comer mantenida para servicio de consumo inmediato. Enseñamos la versión limitada hasta que el condado conteste."
            ]
        },
        {
            id: "fs5-l5",
            titleEn: "Rice, noodles, sprouts and sauces",
            titleEs: "Arroz, fideos, germinados y salsas",
            contentEn: [
                "Fried rice is made to order and never held. Only the rice is made ahead. Cooked rice and noodles are TCS, so they need 41°F, 135°F or written time control.",
                "## Pick one route for rice",
                "| Route | Start | Limit |",
                "| For today (time) | 135°F or above by probe, with the toss time marked | Served or tossed within 4 hours |",
                "| For the fridge (cooling) | 135°F or above when the clock starts | 70°F by 2 hours, then 41°F within 4 more hours, never past 6 total |",
                "Time-marked rice is served or tossed by its mark. It doesn't go in the fridge for tomorrow. The 6-hour time route never helps hot rice, because it has to start at 41°F or below.",
                "!! OPEN QUESTION: It's not confirmed yet whether the county accepts time control for cooker-fresh rice. Keep the written procedure and the Rice Log complete. Two local inspection reports show inspectors asking for proof, one of them on rice.",
                "## Other foods",
                "Sprouts are TCS, not a garnish you can leave out. Keep them at 41°F. A garnish plate that went to a guest doesn't go back into stock.",
                "Sauces with egg or with raw garlic in oil stay at 41°F with a date. So do pickles, vinaigrettes and bottled sauces. Acid doesn't let you leave them out, and adding vinegar to skip temperature control needs a variance.",
                "Vietnamese coffee, ganache and coconut condensed milk get treated as TCS, with cooling limits."
            ],
            contentEs: [
                "El arroz frito se hace al momento y nunca se mantiene. Solo el arroz se hace por adelantado. El arroz y los fideos cocidos son TCS, así que necesitan 41°F, 135°F o control de tiempo escrito.",
                "## Escoge una ruta para el arroz",
                "| Ruta | Inicio | Límite |",
                "| Para hoy (tiempo) | 135°F o más con termómetro, con la hora de tirar marcada | Servido o tirado en 4 horas o menos |",
                "| Para el refrigerador (enfriar) | 135°F o más cuando empieza el reloj | 70°F en 2 horas, luego 41°F en 4 horas más, nunca más de 6 en total |",
                "El arroz marcado con tiempo se sirve o se tira a su hora. No va al refrigerador para mañana. La ruta de 6 horas nunca ayuda al arroz caliente, porque tiene que empezar a 41°F o menos.",
                "!! PREGUNTA ABIERTA: Todavía no está confirmado si el condado acepta el control de tiempo para arroz recién salido de la arrocera. Mantén completos el procedimiento escrito y el Registro de Arroz. Dos reportes locales muestran inspectores pidiendo comprobantes, uno de ellos sobre arroz.",
                "## Otras comidas",
                "Los germinados son TCS, no una decoración que se puede dejar afuera. Mantenlos a 41°F. Un plato de guarnición que fue a un cliente no regresa al inventario.",
                "Las salsas con huevo o con ajo crudo en aceite se quedan a 41°F con fecha. Igual los encurtidos, las vinagretas y las salsas embotelladas. El ácido no te deja tenerlas afuera, y agregar vinagre para saltarte el control de temperatura necesita una variación.",
                "El café vietnamita, el ganache y la leche condensada de coco se tratan como TCS, con límites de enfriamiento."
            ]
        },
        {
            id: "fs5-l6",
            titleEn: "Serving, catering and delivery",
            titleEs: "Servir, catering y entregas",
            contentEn: [
                "| Situation | Rule |",
                "| Food a guest returned | Never re-served. Only sealed non-TCS packages and closed narrow-neck bottles of non-TCS condiments are excepted |",
                "| DD sauce or another TCS sauce on a table | Doesn't pass from guest to guest |",
                "| Serving utensils between uses | In the food with the handle up, or on a clean, sanitized surface |",
                "| Self-service | Guards, one utensil per food, labels, someone watching it |",
                "| Take-home containers a guest brings back | No food refills, as a store rule |",
                "## Catering and delivery",
                "Under county law, catering and delivery count as a food establishment. Every temperature rule still applies.",
                "• Use insulated containers that keep food protected and at temperature",
                "• Keep raw poultry away from ready-to-eat food in transit",
                "• County event checklist: no sterno, heat lamps, crockpots or household fridges",
                "• Food with no date has to be gone within 24 hours"
            ],
            contentEs: [
                "| Situación | Regla |",
                "| Comida que un cliente regresó | Nunca se vuelve a servir. Solo se exceptúan paquetes sellados no TCS y botellas cerradas de cuello angosto con condimentos no TCS |",
                "| Salsa DD u otra salsa TCS en una mesa | No pasa de un cliente a otro |",
                "| Utensilios para servir entre usos | En la comida con el mango hacia arriba, o en una superficie limpia y sanitizada |",
                "| Autoservicio | Protectores, un utensilio por comida, etiquetas, alguien vigilando |",
                "| Contenedores que un cliente trae de regreso | No se rellenan con comida, como regla de la tienda |",
                "## Catering y entregas",
                "Bajo la ley del condado, el catering y las entregas cuentan como un establecimiento de comida. Todas las reglas de temperatura siguen aplicando.",
                "• Usa contenedores aislantes que mantengan la comida protegida y a temperatura",
                "• Mantén el pollo crudo lejos de la comida lista para comer durante el transporte",
                "• Lista del condado para eventos: nada de sterno, lámparas de calor, ollas de cocción lenta ni refrigeradores de casa",
                "• La comida sin fecha tiene que terminarse en 24 horas o menos"
            ]
        }
    ],
    quiz: {
        passThreshold: 0.85,
        questions: [
            {
                id: "fs5-q1",
                questionEn: "A tub of cooked rice came out of the cooker at 1 PM, probed above 135°F and was marked for time control with a 5 PM toss time. At 5:10 PM there's still rice in it. What do you do?",
                questionEs: "Una tina de arroz cocido salió de la arrocera a la 1 PM, marcó más de 135°F y se marcó con control de tiempo para tirar a las 5 PM. A las 5:10 PM todavía queda arroz. ¿Qué haces?",
                options: [
                    { id: "a", textEn: "Move it to the fridge for tomorrow", textEs: "Pasarla al refrigerador para mañana" },
                    { id: "b", textEn: "Toss it, because the time mark has passed", textEs: "Tirarla, porque ya pasó la hora marcada" },
                    { id: "c", textEn: "Reheat it to 165°F and start a new clock", textEs: "Recalentarla a 165°F y empezar otro reloj" },
                    { id: "d", textEn: "Use it, since the 6-hour route allows until 7 PM", textEs: "Usarla, porque la ruta de 6 horas permite hasta las 7 PM" }
                ],
                correct: "b"
            },
            {
                id: "fs5-q2",
                questionEn: "A tub of cooked rice is on the counter with no time mark. Nobody knows when it came out. What's the call?",
                questionEs: "Una tina de arroz cocido está en el mostrador sin marca de hora. Nadie sabe cuándo salió. ¿Qué se hace?",
                options: [
                    { id: "a", textEn: "Write the current time on it", textEs: "Escribirle la hora actual" },
                    { id: "b", textEn: "Put it in the walk-in right away", textEs: "Ponerla en el walk-in de inmediato" },
                    { id: "c", textEn: "Toss it", textEs: "Tirarla" },
                    { id: "d", textEn: "Fry it, since frying makes it safe", textEs: "Freírla, porque freírla la hace segura" }
                ],
                correct: "c"
            },
            {
                id: "fs5-q3",
                questionEn: "A pan of cooked noodles started cooling at 135°F. Two hours later it probes well above 70°F. What's the store rule?",
                questionEs: "Una charola de fideos cocidos empezó a enfriarse a 135°F. Dos horas después marca bastante más de 70°F. ¿Cuál es la regla de la tienda?",
                options: [
                    { id: "a", textEn: "Throw it out", textEs: "Tirarla" },
                    { id: "b", textEn: "Keep cooling, since you have 6 hours", textEs: "Seguir enfriando, porque tienes 6 horas" },
                    { id: "c", textEn: "Put a lid on it and move it to the walk-in", textEs: "Taparla y pasarla al walk-in" },
                    { id: "d", textEn: "Write 70°F on the log and keep going", textEs: "Escribir 70°F en el registro y seguir" }
                ],
                correct: "a"
            },
            {
                id: "fs5-q4",
                questionEn: "Leftover pho broth has to be cooled, and it's a full, deep pot. What's the right move?",
                questionEs: "Hay que enfriar caldo de pho que sobró y es una olla llena y honda. ¿Qué es lo correcto?",
                options: [
                    { id: "a", textEn: "Put the whole pot in the walk-in with the lid on, since the walk-in does the cooling", textEs: "Meter toda la olla al walk-in con la tapa puesta, porque el walk-in hace el enfriamiento" },
                    { id: "b", textEn: "Leave it on the counter until the steam stops", textEs: "Dejarla en el mostrador hasta que deje de salir vapor" },
                    { id: "c", textEn: "Add cold tap water until it's cool", textEs: "Agregar agua fría de la llave hasta que se enfríe" },
                    { id: "d", textEn: "Divide it into smaller containers or use an ice bath, and probe it", textEs: "Dividirlo en contenedores chicos o usar baño de hielo, y medirlo" }
                ],
                correct: "d"
            },
            {
                id: "fs5-q5",
                questionEn: "Chilled pho broth needs to go on the line. Someone pours it straight into the hot-holding unit to heat up. What's wrong?",
                questionEs: "Caldo de pho frío tiene que ir a la línea. Alguien lo vacía directo en el equipo de mantener caliente para calentarlo. ¿Qué está mal?",
                options: [
                    { id: "a", textEn: "Nothing, as long as it reaches 135°F in the unit sometime before the lunch rush starts", textEs: "Nada, siempre que llegue a 135°F en el equipo antes de que empiece la hora del almuerzo" },
                    { id: "b", textEn: "It must be reheated elsewhere to 165°F for 15 seconds within 2 hours, then held", textEs: "Debe recalentarse en otro lado a 165°F por 15 segundos en 2 horas o menos, y luego mantenerse" },
                    { id: "c", textEn: "It must be reheated to 135°F for 15 seconds", textEs: "Debe recalentarse a 135°F por 15 segundos" },
                    { id: "d", textEn: "It only needs a stir every 4 hours", textEs: "Solo necesita moverse cada 4 horas" }
                ],
                correct: "b"
            },
            {
                id: "fs5-q6",
                questionEn: "A prep sheet from last year says to keep cold food \"below 45°F.\" The sprout pan reads 45°F. What do you do?",
                questionEs: "Una hoja de preparación del año pasado dice mantener lo frío \"abajo de 45°F.\" La charola de germinados marca 45°F. ¿Qué haces?",
                options: [
                    { id: "a", textEn: "Nothing, because the sheet says it's fine", textEs: "Nada, porque la hoja dice que está bien" },
                    { id: "b", textEn: "Add a few ice cubes on top of the sprouts", textEs: "Poner unos hielos encima de los germinados" },
                    { id: "c", textEn: "Our rule is 41°F. Tell the person in charge and fix it", textEs: "Nuestra regla es 41°F. Avisarle a la persona a cargo y arreglarlo" },
                    { id: "d", textEn: "Check it again at the end of the shift, since 45°F is what the older sheet allows", textEs: "Revisarla otra vez al final del turno, porque 45°F es lo que permite la hoja vieja" }
                ],
                correct: "c"
            },
            {
                id: "fs5-q7",
                questionEn: "The egg roll warmer feels warm but reads below 135°F, and nobody marked a time. A coworker says it's only been out an hour. What's correct?",
                questionEs: "El calentador de egg rolls se siente tibio pero marca menos de 135°F, y nadie marcó la hora. Un compañero dice que solo lleva una hora. ¿Qué es correcto?",
                options: [
                    { id: "a", textEn: "It already breaks the rule. It needs 135°F or above, or written time control", textEs: "Ya rompe la regla. Necesita 135°F o más, o control de tiempo escrito" },
                    { id: "b", textEn: "It's fine for up to 4 hours in the danger zone, so just mark the time on it now", textEs: "Está bien hasta 4 horas en la zona de peligro, así que solo márcale la hora ahora" },
                    { id: "c", textEn: "It's fine, because fried food is safe", textEs: "Está bien, porque lo frito es seguro" },
                    { id: "d", textEn: "Turn the warmer up and keep the same egg rolls with no record", textEs: "Subir el calentador y dejar los mismos egg rolls sin registro" }
                ],
                correct: "a"
            },
            {
                id: "fs5-q8",
                questionEn: "A manager wants to hold cut lettuce at the counter on time, starting from 70°F. What's our answer?",
                questionEs: "Un gerente quiere mantener lechuga cortada en el mostrador con tiempo, empezando a 70°F. ¿Cuál es nuestra respuesta?",
                options: [
                    { id: "a", textEn: "OK, 70°F with a 4-hour mark", textEs: "Está bien, 70°F con una marca de 4 horas" },
                    { id: "b", textEn: "OK, 70°F with a 6-hour mark", textEs: "Está bien, 70°F con una marca de 6 horas" },
                    { id: "c", textEn: "OK, if it goes back in the fridge at close", textEs: "Está bien, si regresa al refrigerador al cierre" },
                    { id: "d", textEn: "Not here. It has to start at 41°F or below", textEs: "Aquí no. Tiene que empezar a 41°F o menos" }
                ],
                correct: "d"
            },
            {
                id: "fs5-q9",
                questionEn: "Someone argues the pickled vegetables and a vinegar sauce can stay out all day because acid keeps them safe. What's our rule?",
                questionEs: "Alguien dice que los encurtidos y una salsa de vinagre pueden estar afuera todo el día porque el ácido los protege. ¿Cuál es nuestra regla?",
                options: [
                    { id: "a", textEn: "True, as long as they're covered, because acid stops germs from growing in a sauce", textEs: "Es cierto, siempre que estén tapados, porque el ácido no deja crecer gérmenes en una salsa" },
                    { id: "b", textEn: "Keep them cold with a date. Using vinegar to skip that needs a variance", textEs: "Mantenerlos fríos con fecha. Usar vinagre para saltarse eso necesita una variación" },
                    { id: "c", textEn: "True, for up to one week", textEs: "Es cierto, hasta por una semana" },
                    { id: "d", textEn: "True, if the sauce tastes sour", textEs: "Es cierto, si la salsa sabe ácida" }
                ],
                correct: "b"
            },
            {
                id: "fs5-q10",
                questionEn: "A guest returns a lidded cup of DD sauce they didn't open. Can you give it to the next guest?",
                questionEs: "Un cliente regresa un vasito tapado de salsa DD que no abrió. ¿Se lo puedes dar al siguiente cliente?",
                options: [
                    { id: "a", textEn: "Yes, if the lid never came off, because then nothing could have touched it", textEs: "Sí, si nunca le quitó la tapa, porque así nada pudo haberla tocado" },
                    { id: "b", textEn: "Yes, if you put it back in the fridge first", textEs: "Sí, si primero lo regresas al refrigerador" },
                    { id: "c", textEn: "No. A TCS sauce doesn't pass from guest to guest", textEs: "No. Una salsa TCS no pasa de un cliente a otro" },
                    { id: "d", textEn: "Yes, if it's the same day", textEs: "Sí, si es el mismo día" }
                ],
                correct: "c"
            }
        ]
    }
};

export const FS6_CLEANING_EMERGENCIES = {
    id: "fs6",
    code: "FS6",
    track: "food-safety",
    tier: "all",
    draft: true,
    icon: "🧽",
    durationMin: 30,
    titleEn: "Cleaning and Emergencies",
    titleEs: "Limpieza y Emergencias",
    lessons: [
        {
            id: "fs6-l1",
            titleEn: "Cleaning and sanitizing",
            titleEs: "Limpiar y sanitizar",
            contentEn: [
                "| Word | Meaning |",
                "| Cleaning | Removes food and soil |",
                "| Sanitizing | Reduces germs on a surface that's already clean |",
                "| Disinfecting | Stronger, used for vomit and other bodily fluids |",
                "## Surface steps",
                "Scrape, wash, rinse, sanitize, air-dry. Sanitizer can't work on a dirty surface.",
                "## When",
                "• Each time you change food or task",
                "• At least every 4 hours if the surface is in constant use",
                "• Cold rooms at 41°F or below may stretch up to 24 hours",
                "## Wiping cloths",
                "Wet cloths stay in sanitizer between uses, off the floor. Raw-meat cloths stay separate. Launder them daily. Dry cloths for spills get used for nothing else. Sponges never go on sanitized surfaces."
            ],
            contentEs: [
                "| Palabra | Significado |",
                "| Limpiar | Quita comida y suciedad |",
                "| Sanitizar | Reduce gérmenes en una superficie ya limpia |",
                "| Desinfectar | Más fuerte, se usa para vómito y otros fluidos del cuerpo |",
                "## Pasos para superficies",
                "Raspar, lavar, enjuagar, sanitizar, secar al aire. El sanitizante no funciona en una superficie sucia.",
                "## Cuándo",
                "• Cada vez que cambies de comida o de tarea",
                "• Por lo menos cada 4 horas si la superficie se usa sin parar",
                "• Los cuartos fríos a 41°F o menos pueden extenderse hasta 24 horas",
                "## Trapos",
                "Los trapos húmedos se quedan en sanitizante entre usos, fuera del piso. Los trapos de carne cruda van aparte. Lávalos todos los días. Los trapos secos para derrames no se usan para nada más. Las esponjas nunca van en superficies sanitizadas."
            ]
        },
        {
            id: "fs6-l2",
            titleEn: "Sanitizer strength and sinks",
            titleEs: "Fuerza del sanitizante y fregaderos",
            contentEn: [
                "Read the label on the chemical in front of you and test with a strip made for that chemical. Different products need different strips. Follow the label and meet this chart too.",
                "| Sanitizer | Strength and water | Contact time |",
                "| Chlorine | 25 ppm at 120°F | 10 seconds |",
                "| Chlorine | 50 ppm at 100°F (pH 10 or less) or 75°F (pH 8 or less) | 7 seconds |",
                "| Chlorine | 100 ppm at 55°F | 10 seconds |",
                "| Iodine | 12.5-25 ppm at 75°F, pH 5 or less | 30 seconds |",
                "| Quat | Per label, at 75°F, hardness 500 ppm or less | 30 seconds |",
                "| Hot water by hand | 171°F | 30 seconds |",
                "ppm means parts per million, the strength of a sanitizer.",
                "## Three-compartment sink",
                "Clean the sinks first. Wash at 110°F or per the label, rinse, sanitize, then air-dry.",
                "## Dish machines",
                "Follow the data plate on your machine. A chemical machine washes at 120°F or higher, with sanitizer per the chart. A hot-water machine rinses at 180°F in most cases, and dish surfaces reach 160°F."
            ],
            contentEs: [
                "Lee la etiqueta del químico que tienes enfrente y prueba con una tira hecha para ese químico. Productos distintos necesitan tiras distintas. Sigue la etiqueta y también cumple esta tabla.",
                "| Sanitizante | Fuerza y agua | Tiempo de contacto |",
                "| Cloro | 25 ppm a 120°F | 10 segundos |",
                "| Cloro | 50 ppm a 100°F (pH 10 o menos) o 75°F (pH 8 o menos) | 7 segundos |",
                "| Cloro | 100 ppm a 55°F | 10 segundos |",
                "| Yodo | 12.5-25 ppm a 75°F, pH 5 o menos | 30 segundos |",
                "| Cuaternario | Según la etiqueta, a 75°F, dureza de 500 ppm o menos | 30 segundos |",
                "| Agua caliente a mano | 171°F | 30 segundos |",
                "ppm significa partes por millón, la fuerza de un sanitizante.",
                "## Fregadero de tres compartimentos",
                "Limpia primero los fregaderos. Lava a 110°F o según la etiqueta, enjuaga, sanitiza y seca al aire.",
                "## Lavaplatos",
                "Sigue la placa de datos de tu máquina. Una máquina química lava a 120°F o más, con sanitizante según la tabla. Una máquina de agua caliente enjuaga a 180°F en la mayoría de los casos, y la superficie de los platos llega a 160°F."
            ]
        },
        {
            id: "fs6-l3",
            titleEn: "Chemicals",
            titleEs: "Químicos",
            contentEn: [
                "| Rule | What you do |",
                "| Storage | Apart from food and never above it. Everything labeled |",
                "| Spray bottles | Label each one with what's in it |",
                "| Chemical containers | Never reuse them for food, equipment, utensils or linens |",
                "| Food containers | Never put chemicals in them |",
                "| Medicine, first aid, personal items | Away from food |",
                "| Safety Data Sheets | One for each hazardous chemical, reachable on every shift |",
                "Safety Data Sheets come from OSHA's workplace safety rule, not the food code. Keep them anyway."
            ],
            contentEs: [
                "| Regla | Qué haces |",
                "| Almacenamiento | Aparte de la comida y nunca encima. Todo con etiqueta |",
                "| Botellas con atomizador | Ponle a cada una una etiqueta de lo que contiene |",
                "| Contenedores de químicos | Nunca los reuses para comida, equipo, utensilios o manteles |",
                "| Contenedores de comida | Nunca pongas químicos en ellos |",
                "| Medicinas, primeros auxilios, cosas personales | Lejos de la comida |",
                "| Hojas de Datos de Seguridad | Una por cada químico peligroso, a la mano en cada turno |",
                "Las Hojas de Datos de Seguridad vienen de la regla de seguridad en el trabajo de OSHA, no del código de comida. Guárdalas de todos modos."
            ]
        },
        {
            id: "fs6-l4",
            titleEn: "Pests, trash, mop water and animals",
            titleEs: "Plagas, basura, agua de trapeador y animales",
            contentEn: [
                "| Topic | Rule |",
                "| Pests | Zero is the standard. Keep them out, take away food and shelter, and use a licensed operator. Tell a manager the moment you see one |",
                "| Garbage | Covered, leakproof containers, cleaned away from food, with pickup at least weekly |",
                "| Mop water | Service sink or curbed drain only. Never a food, hand or dish sink, or a toilet |",
                "| Animals | Service animals are allowed where no hazard results, and not where food is prepared. No pet dogs, including on the patio |"
            ],
            contentEs: [
                "| Tema | Regla |",
                "| Plagas | La meta es cero. Mantenlas afuera, quítales comida y refugio, y usa un operador con licencia. Avísale a un gerente en cuanto veas una |",
                "| Basura | Contenedores tapados y a prueba de fugas, limpiados lejos de la comida, con recolección por lo menos cada semana |",
                "| Agua de trapeador | Solo fregadero de servicio o drenaje con borde. Nunca un fregadero de comida, de manos o de platos, ni un inodoro |",
                "| Animales | Se permiten animales de servicio donde no haya riesgo, y no donde se prepara comida. Nada de perros mascota, tampoco en el patio |"
            ]
        },
        {
            id: "fs6-l5",
            titleEn: "Vomit and diarrhea cleanup",
            titleEs: "Limpieza de vómito y diarrea",
            contentEn: [
                "Regular sanitizer isn't enough for vomit. This calls for a disinfectant.",
                "## Steps",
                "• Get the person in charge and keep guests and staff away from the area",
                "• Keep anyone who's sick away from food",
                "• Use the cleanup kit and the written plan. If you can't find either one, tell the person in charge",
                "• Wear single-use gloves and follow the kit's directions",
                "• Use an EPA-approved disinfectant per its label. One restaurant trade source suggests 1,000-5,000 ppm bleach for norovirus",
                "• Throw out any food that may have been exposed",
                "• Throw away gloves and cleanup materials, then wash your hands well",
                "!! WHERE THIS COMES FROM: The county code has no section on this. FDA's newer code and the manager exam expect it, so we do it."
            ],
            contentEs: [
                "El sanitizante normal no basta para el vómito. Esto requiere un desinfectante.",
                "## Pasos",
                "• Busca a la persona a cargo y mantén a clientes y empleados lejos del área",
                "• Mantén lejos de la comida a cualquier persona enferma",
                "• Usa el kit de limpieza y el plan escrito. Si no encuentras alguno de los dos, avísale a la persona a cargo",
                "• Ponte guantes desechables y sigue las instrucciones del kit",
                "• Usa un desinfectante aprobado por la EPA según su etiqueta. Una fuente de la industria restaurantera sugiere cloro de 1,000-5,000 ppm para norovirus",
                "• Tira cualquier comida que pudo quedar expuesta",
                "• Tira los guantes y los materiales de limpieza, y luego lávate bien las manos",
                "!! DE DÓNDE VIENE ESTO: El código del condado no tiene una sección sobre esto. El código más nuevo de la FDA y el examen de gerentes lo esperan, así que lo hacemos."
            ]
        },
        {
            id: "fs6-l6",
            titleEn: "Outages and when to call the county",
            titleEs: "Apagones y cuándo llamar al condado",
            contentEn: [
                "!! COUNTY NUMBER: (314) 615-8900, Mon-Fri 8:00-4:30, food.dph@stlouiscountymo.gov. We haven't found an after-hours number. After hours, call the owner or manager right away and email the county.",
                "## Call first",
                "| Event | What you do |",
                "| Fire, flood, power outage or similar event that could contaminate food or stop temperature holding | Tell the person in charge. The person in charge calls the county immediately |",
                "| Any loss of drinking water | Same |",
                "| Sewage backup, or anything else that might be an imminent hazard | Stop and notify the county |",
                "| Two sick guests from one meal | Call the county now, take down details, keep sick staff out |",
                "Our house rule is to call for every one of these. Unaffected parts of the store may keep running, but you need approval from the county before you start back up where you stopped.",
                "After a flood, throw out soft packaging that floodwater touched. Check any bleach strength against the label.",
                "!! EXAM NOTE: ServSafe's materials teach deciding if the risk is significant, and FDA's newer code allows operating through a water or power loss under a pre-approved written plan. The county has no such plan option, so we call first."
            ],
            contentEs: [
                "!! NÚMERO DEL CONDADO: (314) 615-8900, lunes a viernes 8:00-4:30, food.dph@stlouiscountymo.gov. No hemos encontrado un número para fuera de horario. Fuera de horario, llama de inmediato al dueño o al gerente y mándale un correo al condado.",
                "## Llama primero",
                "| Evento | Qué haces |",
                "| Incendio, inundación, apagón o evento parecido que pueda contaminar la comida o impedir mantener la temperatura | Avísale a la persona a cargo. La persona a cargo llama al condado de inmediato |",
                "| Cualquier pérdida de agua potable | Lo mismo |",
                "| Regreso de aguas negras, o cualquier otra cosa que pueda ser un peligro inminente | Detente y avísale al condado |",
                "| Dos clientes enfermos por una misma comida | Llama al condado ya, anota los detalles, mantén fuera a los empleados enfermos |",
                "Nuestra regla de la casa es llamar por todos estos. Las partes de la tienda que no se afectaron pueden seguir, pero necesitas la aprobación del condado antes de volver a empezar donde paraste.",
                "Después de una inundación, tira los empaques blandos que tocó el agua. Revisa cualquier fuerza de cloro con la etiqueta.",
                "!! NOTA DE EXAMEN: Los materiales de ServSafe enseñan a decidir si el riesgo es importante, y el código más nuevo de la FDA permite operar durante una pérdida de agua o luz con un plan escrito aprobado por adelantado. El condado no tiene esa opción de plan, así que llamamos primero."
            ]
        }
    ],
    quiz: {
        passThreshold: 0.85,
        questions: [
            {
                id: "fs6-q1",
                questionEn: "You've just cut raw chicken on a board and need to slice bánh mì vegetables next. What's the right order?",
                questionEs: "Acabas de cortar pollo crudo en una tabla y luego necesitas rebanar verduras para bánh mì. ¿Cuál es el orden correcto?",
                options: [
                    { id: "a", textEn: "Wipe with a wet towel and start slicing", textEs: "Limpiar con un trapo húmedo y empezar a rebanar" },
                    { id: "b", textEn: "Spray sanitizer over the board and go", textEs: "Rociar sanitizante en la tabla y seguir" },
                    { id: "c", textEn: "Flip the board over to the clean side", textEs: "Voltear la tabla al lado limpio" },
                    { id: "d", textEn: "Scrape, wash, rinse, sanitize, air-dry", textEs: "Raspar, lavar, enjuagar, sanitizar, secar al aire" }
                ],
                correct: "d"
            },
            {
                id: "fs6-q2",
                questionEn: "A prep table has been in constant use all morning with the same kind of food. How often does it need cleaning and sanitizing?",
                questionEs: "Una mesa de preparación se ha usado sin parar toda la mañana con el mismo tipo de comida. ¿Cada cuánto hay que limpiarla y sanitizarla?",
                options: [
                    { id: "a", textEn: "At least every 4 hours", textEs: "Por lo menos cada 4 horas" },
                    { id: "b", textEn: "Once at closing", textEs: "Una vez al cierre" },
                    { id: "c", textEn: "Only when you can see food on it", textEs: "Solo cuando se vea comida encima" },
                    { id: "d", textEn: "At least every 24 hours", textEs: "Por lo menos cada 24 horas" }
                ],
                correct: "a"
            },
            {
                id: "fs6-q3",
                questionEn: "You test the sanitizer bucket and aren't sure if the strip matches the chemical. What do you do?",
                questionEs: "Pruebas la cubeta de sanitizante y no sabes si la tira corresponde al químico. ¿Qué haces?",
                options: [
                    { id: "a", textEn: "Add a little extra chemical to be safe, since stronger sanitizer always works better", textEs: "Agregar un poco más de químico para estar seguro, porque más fuerte siempre funciona mejor" },
                    { id: "b", textEn: "Go with the color that looks closest", textEs: "Hacerle caso al color que se vea más parecido" },
                    { id: "c", textEn: "Read the label and use the strip for that chemical, or ask a manager", textEs: "Leer la etiqueta y usar la tira de ese químico, o preguntarle a un gerente" },
                    { id: "d", textEn: "Skip the test if the water smells strong", textEs: "No hacer la prueba si el agua huele fuerte" }
                ],
                correct: "c"
            },
            {
                id: "fs6-q4",
                questionEn: "You run out of spray bottles, and someone suggests rinsing out an old sauce squeeze bottle for sanitizer. What's the rule?",
                questionEs: "Se acaban los atomizadores y alguien sugiere enjuagar una botella vieja de salsa para el sanitizante. ¿Cuál es la regla?",
                options: [
                    { id: "a", textEn: "Fine, if the bottle gets a label", textEs: "Está bien, si la botella lleva etiqueta" },
                    { id: "b", textEn: "No. Chemicals don't go in food containers", textEs: "No. Los químicos no van en contenedores de comida" },
                    { id: "c", textEn: "Fine, if you wash the bottle twice", textEs: "Está bien, si lavas la botella dos veces" },
                    { id: "d", textEn: "Fine, if you keep it away from the line", textEs: "Está bien, si la mantienes lejos de la línea" }
                ],
                correct: "b"
            },
            {
                id: "fs6-q5",
                questionEn: "At close, you see one roach near the dry storage shelf. What do you do?",
                questionEs: "Al cierre, ves una cucaracha cerca de la repisa de almacén seco. ¿Qué haces?",
                options: [
                    { id: "a", textEn: "Tell a manager right away, because zero is the standard", textEs: "Avisarle a un gerente de inmediato, porque la meta es cero" },
                    { id: "b", textEn: "Spray kitchen sanitizer on it and forget it", textEs: "Rociarle sanitizante y olvidarlo" },
                    { id: "c", textEn: "Wait until you see more than one", textEs: "Esperar hasta ver más de una" },
                    { id: "d", textEn: "Move the food around to cover the spot, then report it at the next monthly service", textEs: "Mover la comida para tapar el lugar, y avisar en el siguiente servicio mensual" }
                ],
                correct: "a"
            },
            {
                id: "fs6-q6",
                questionEn: "The mop bucket is full and the mop sink is blocked by boxes. Where can the dirty water go?",
                questionEs: "La cubeta de trapeador está llena y el fregadero de servicio está tapado con cajas. ¿Dónde puede ir el agua sucia?",
                options: [
                    { id: "a", textEn: "The restroom toilet", textEs: "El inodoro del baño" },
                    { id: "b", textEn: "The hand sink, then rinse it well so it's ready for the next person", textEs: "El lavamanos, y luego enjuagarlo bien para que quede listo para el siguiente" },
                    { id: "c", textEn: "The prep sink, then sanitize it", textEs: "El fregadero de preparación, y luego sanitizarlo" },
                    { id: "d", textEn: "Move the boxes and use the service sink", textEs: "Quitar las cajas y usar el fregadero de servicio" }
                ],
                correct: "d"
            },
            {
                id: "fs6-q7",
                questionEn: "A guest vomits near the counter at lunch. What do you do first?",
                questionEs: "Un cliente vomita cerca del mostrador a la hora del almuerzo. ¿Qué haces primero?",
                options: [
                    { id: "a", textEn: "Mop it right away with the regular sanitizer, so guests don't have to see it", textEs: "Trapear de inmediato con el sanitizante normal, para que los clientes no lo vean" },
                    { id: "b", textEn: "Get the person in charge and keep people away from the area", textEs: "Buscar a la persona a cargo y mantener a la gente lejos del área" },
                    { id: "c", textEn: "Cover it with a towel until close", textEs: "Taparlo con un trapo hasta el cierre" },
                    { id: "d", textEn: "Keep serving, since it's on the guest side", textEs: "Seguir sirviendo, porque está del lado de los clientes" }
                ],
                correct: "b"
            },
            {
                id: "fs6-q8",
                questionEn: "The power goes out during lunch and the walk-in stops running. You're the person in charge. What's your first call?",
                questionEs: "Se va la luz durante el almuerzo y el walk-in deja de funcionar. Tú eres la persona a cargo. ¿Cuál es tu primera llamada?",
                options: [
                    { id: "a", textEn: "The county, at (314) 615-8900", textEs: "Al condado, al (314) 615-8900" },
                    { id: "b", textEn: "No call. Wait to see how long it lasts", textEs: "Ninguna. Esperar a ver cuánto dura" },
                    { id: "c", textEn: "The refrigeration repair company, and nobody else", textEs: "La compañía de refrigeración, y nadie más" },
                    { id: "d", textEn: "No call, if you keep the walk-in door shut", textEs: "Ninguna, si mantienes cerrada la puerta del walk-in" }
                ],
                correct: "a"
            },
            {
                id: "fs6-q9",
                questionEn: "The city shuts off drinking water for an hour of repairs. A coworker says we can keep going with bottled water. What's our rule?",
                questionEs: "La ciudad corta el agua potable por una hora de reparaciones. Un compañero dice que podemos seguir con agua embotellada. ¿Cuál es nuestra regla?",
                options: [
                    { id: "a", textEn: "Keep going, since it's only an hour", textEs: "Seguir, porque es solo una hora" },
                    { id: "b", textEn: "Keep going, if the hand sinks have soap", textEs: "Seguir, si los lavamanos tienen jabón" },
                    { id: "c", textEn: "The person in charge calls the county immediately", textEs: "La persona a cargo llama al condado de inmediato" },
                    { id: "d", textEn: "Keep going, and tell the county at the next inspection", textEs: "Seguir, y decirle al condado en la siguiente inspección" }
                ],
                correct: "c"
            },
            {
                id: "fs6-q10",
                questionEn: "Two guests from the same table call the next morning to say they both got sick after eating here. What do you do?",
                questionEs: "Dos clientes de la misma mesa llaman a la mañana siguiente para decir que se enfermaron después de comer aquí. ¿Qué haces?",
                options: [
                    { id: "a", textEn: "Offer a coupon and close the matter", textEs: "Ofrecer un cupón y cerrar el asunto" },
                    { id: "b", textEn: "Tell them it couldn't have been our food", textEs: "Decirles que no pudo ser nuestra comida" },
                    { id: "c", textEn: "Wait to see if a third person calls, since two could be a coincidence at one table", textEs: "Esperar a ver si llama una tercera persona, porque dos pueden ser coincidencia en una mesa" },
                    { id: "d", textEn: "Take down details, tell the person in charge and call the county now", textEs: "Anotar los detalles, avisarle a la persona a cargo y llamar al condado ya" }
                ],
                correct: "d"
            }
        ]
    }
};

export const FS7_INSPECTIONS = {
    id: "fs7",
    code: "FS7",
    track: "food-safety",
    tier: "all",
    draft: true,
    icon: "📋",
    durationMin: 30,
    titleEn: "Inspections and the Person in Charge",
    titleEs: "Inspecciones y la Persona a Cargo",
    lessons: [
        {
            id: "fs7-l1",
            titleEn: "Who's responsible",
            titleEs: "Quién es responsable",
            contentEn: [
                "Both stores follow St. Louis County Chapter 807, which is the FDA 2005 Food Code plus county changes. A person in charge must be present all hours of operation.",
                "## What the person in charge watches",
                "• Handwashing and bare hands",
                "• Receiving, cooking and cooling",
                "• Holding and thawing",
                "• Sanitizing",
                "• Illness reporting and staff training",
                "• The consumer advisory",
                "## The certified manager",
                "A certified food protection manager is someone who passed an accredited, proctored exam. Our rule: a certified person is here every hour the building is occupied, including prep and close.",
                "!! COUNTY PRACTICE, NOT CODE: The code doesn't say this outright. A 2019 county inspector's note on a mobile-unit report says so, and reports from 2011-2013 cite missing certificates. We follow the stricter reading until the county says otherwise.",
                "## What doesn't count",
                "A food handler card isn't a county requirement and doesn't cover the manager rule. A DD Mau module completion is a training record, not a certification. Only the proctored exam gives certification.",
                "Train people at hire and regularly, and keep records. Staff sign Form 1-B so we can show they were told their illness duty."
            ],
            contentEs: [
                "Las dos tiendas siguen el Capítulo 807 del condado de St. Louis, que es el Código de Alimentos de la FDA de 2005 más cambios del condado. Una persona a cargo debe estar presente todas las horas de operación.",
                "## Qué vigila la persona a cargo",
                "• Lavado de manos y manos sin guantes",
                "• Recibir, cocinar y enfriar",
                "• Mantener temperatura y descongelar",
                "• Sanitizar",
                "• Avisos de enfermedad y capacitación del personal",
                "• El aviso al consumidor",
                "## El gerente certificado",
                "Un gerente certificado en protección de alimentos es alguien que pasó un examen acreditado y supervisado. Nuestra regla: una persona certificada está aquí cada hora que el edificio esté ocupado, incluyendo preparación y cierre.",
                "!! PRÁCTICA DEL CONDADO, NO CÓDIGO: El código no lo dice directamente. Una nota de 2019 de un inspector del condado en un reporte de unidad móvil lo dice, y reportes de 2011-2013 citan certificados faltantes. Seguimos la lectura más estricta hasta que el condado diga otra cosa.",
                "## Qué no cuenta",
                "Una tarjeta de manejo de alimentos no es requisito del condado y no cubre la regla del gerente. Completar un módulo de DD Mau es un registro de capacitación, no una certificación. Solo el examen supervisado da la certificación.",
                "Capacita a la gente al contratarla y con regularidad, y guarda registros. El personal firma el Formulario 1-B para que podamos demostrar que se le informó su deber de avisar enfermedades."
            ]
        },
        {
            id: "fs7-l2",
            titleEn: "When the inspector comes",
            titleEs: "Cuando llega el inspector",
            contentEn: [
                "The county page says 1-4 inspections a year, plus follow-ups and complaints. Expect them unannounced.",
                "## What to do",
                "• Check the inspector's ID, then let them in, at any hour. This goes for openers and closers too",
                "• Call the owner while you cooperate",
                "• Walk with them, and fix what you can on the spot. Items fixed on site get marked COS",
                "• Sign the report. Signing means you received it, not that you agree",
                "• Remember that reports are public",
                "The inspector can see records on food and supplies, people employed and the permit fee.",
                "!! NEVER REFUSE: Refusing or interfering is grounds for suspension with no prior hearing. Held food can't be used or moved."
            ],
            contentEs: [
                "La página del condado dice 1-4 inspecciones al año, más seguimientos y quejas. Espéralas sin aviso.",
                "## Qué hacer",
                "• Revisa la identificación del inspector y déjalo entrar, a cualquier hora. Esto también aplica a quien abre y a quien cierra",
                "• Llama al dueño mientras cooperas",
                "• Camina con el inspector y arregla lo que puedas en el momento. Lo que se arregla ahí se marca COS",
                "• Firma el reporte. Firmar significa que lo recibiste, no que estás de acuerdo",
                "• Recuerda que los reportes son públicos",
                "El inspector puede ver registros de comida y suministros, personas empleadas y la cuota del permiso.",
                "!! NUNCA TE NIEGUES: Negarte o interferir es motivo de suspensión sin audiencia previa. La comida retenida no se puede usar ni mover."
            ]
        },
        {
            id: "fs7-l3",
            titleEn: "Letter grades and what gets posted",
            titleEs: "Calificaciones y qué se publica",
            contentEn: [
                "| Grade | Score |",
                "| A | 90 or more |",
                "| B | 80-89 |",
                "| C | 79 or less |",
                "These bands are written in county law. Whether the county still issues grades is unconfirmed, so read your store's last report. The Director may reset totals yearly.",
                "## Keep where the public can see it",
                "• The permit",
                "• The latest inspection form",
                "• The grade placard, if one was issued",
                "Keep past reports on file too.",
                "## No Smoking",
                "Restaurants are smoke free, including vaping and marijuana, except outdoor dining and lounges. Signs go near all entrances, with 1-inch letters or the symbol. No smoking within 15 feet of entries, with exceptions. Ask anyone smoking to stop and leave. Owner fines go up to $100, $200 and $500 within a year."
            ],
            contentEs: [
                "| Calificación | Puntaje |",
                "| A | 90 o más |",
                "| B | 80-89 |",
                "| C | 79 o menos |",
                "Estos rangos están escritos en la ley del condado. No está confirmado si el condado sigue dando calificaciones, así que lee el último reporte de tu tienda. El Director puede reiniciar los totales cada año.",
                "## Mantener donde el público lo vea",
                "• El permiso",
                "• El último formulario de inspección",
                "• El letrero de calificación, si se dio uno",
                "Guarda también los reportes anteriores.",
                "## No Fumar",
                "Los restaurantes son libres de humo, incluyendo vapeo y marihuana, excepto en comedores al aire libre y lounges. Los letreros van cerca de todas las entradas, con letras de 1 pulgada o el símbolo. No se fuma a menos de 15 pies de las entradas, con excepciones. Pide a quien esté fumando que deje de hacerlo y se vaya. Las multas al dueño llegan a $100, $200 y $500 dentro de un año."
            ]
        },
        {
            id: "fs7-l4",
            titleEn: "Fix deadlines and downgrade costs",
            titleEs: "Plazos para corregir y costos de bajar de calificación",
            contentEn: [
                "| Result | Fix by |",
                "| Critical items | On the spot |",
                "| Score 90 or more | 1- and 2-point items by the next routine inspection |",
                "| Score 80-89 | Everything within 30 days |",
                "| Score 79 or less | Suspension and/or a posted C, fixed within 10 days |",
                "The period written on the report also binds you. A critical item is a code item likely to cause illness. Newer codes split these into Priority and Priority Foundation, and call the rest Core.",
                "## What a downgrade costs",
                "| Item | Amount |",
                "| Not displaying a downgraded grade | $300 fine |",
                "| Each follow-up after a downgrade | $25 |",
                "| Two or more downgrades in a calendar year | 2-hour county Food Safety School, $50 per person. The certified manager must go, and other staff can be required |",
                "Food Safety School doesn't count toward certification."
            ],
            contentEs: [
                "| Resultado | Corregir para |",
                "| Puntos críticos | En el momento |",
                "| Puntaje 90 o más | Puntos de 1 y 2 para la siguiente inspección de rutina |",
                "| Puntaje 80-89 | Todo en 30 días o menos |",
                "| Puntaje 79 o menos | Suspensión y/o una C publicada, corregido en 10 días o menos |",
                "El plazo escrito en el reporte también te obliga. Un punto crítico es un punto del código que probablemente cause enfermedad. Los códigos más nuevos los dividen en Prioritario y Prioritario de Base, y al resto lo llaman Básico.",
                "## Lo que cuesta bajar de calificación",
                "| Concepto | Cantidad |",
                "| No mostrar una calificación más baja | Multa de $300 |",
                "| Cada seguimiento después de bajar | $25 |",
                "| Dos o más bajas en un año calendario | Escuela de Seguridad Alimentaria del condado de 2 horas, $50 por persona. El gerente certificado debe ir, y se puede exigir a otros empleados |",
                "La Escuela de Seguridad Alimentaria no cuenta para la certificación."
            ]
        },
        {
            id: "fs7-l5",
            titleEn: "Honesty, penalties and asking first",
            titleEs: "Honestidad, multas y preguntar primero",
            contentEn: [
                "!! HONEST GAPS: A material misstatement to the county is its own violation. An honest gap in a log beats an invented number. Never fill in a temperature you didn't read.",
                "| Consequence | Details |",
                "| Conviction | Up to $1,000 per violation per day, or a year in jail, or both. Each day is separate, and it reaches responsible officers |",
                "| Suspension | With no prior notice for a public health hazard, interference or score grounds. Operations stop on written notice |",
                "| Hearing | Request one within 10 days. An appeal doesn't pause a suspension |",
                "| Revocation | For repeated violations, unpaid fees or false applications. Reapply 60 days after it's final |",
                "| Held food | Can't be used or moved. It can be destroyed right away if it can't be stored safely |",
                "The county can also order a named employee excluded with no prior hearing.",
                "## Ask the county first",
                "• Vacuum packing TCS food. The code requires a HACCP plan and two safety barriers, with a 14-day limit",
                "• Smoking to preserve, curing, adding vinegar to skip temperature control or growing sprouts. These need a variance",
                "• A menu or process change, which can trigger plan review",
                "• Patio or outdoor cooking",
                "A variance is written permission from the regulator to do something the code doesn't normally allow. Here it goes through the Restaurant Commission on appeal: $300, a public hearing and newspaper notice. Plan not to need one."
            ],
            contentEs: [
                "!! HUECOS HONESTOS: Una declaración falsa importante al condado es una violación por sí sola. Un hueco honesto en un registro es mejor que un número inventado. Nunca escribas una temperatura que no mediste.",
                "| Consecuencia | Detalles |",
                "| Condena | Hasta $1,000 por violación por día, o un año de cárcel, o ambos. Cada día es aparte, y alcanza a los responsables |",
                "| Suspensión | Sin aviso previo por un peligro para la salud pública, interferencia o por el puntaje. La operación se detiene con aviso escrito |",
                "| Audiencia | Pídela en 10 días o menos. Una apelación no detiene una suspensión |",
                "| Revocación | Por violaciones repetidas, cuotas sin pagar o solicitudes falsas. Vuelve a solicitar 60 días después de que sea final |",
                "| Comida retenida | No se puede usar ni mover. Se puede destruir de inmediato si no se puede guardar de forma segura |",
                "El condado también puede ordenar que se excluya a un empleado por nombre sin audiencia previa.",
                "## Pregúntale primero al condado",
                "• Empacar al vacío comida TCS. El código exige un plan HACCP y dos barreras de seguridad, con un límite de 14 días",
                "• Ahumar para conservar, curar, agregar vinagre para saltarse el control de temperatura o cultivar germinados. Estos necesitan una variación",
                "• Un cambio de menú o de proceso, que puede activar una revisión de planos",
                "• Cocinar en el patio o al aire libre",
                "Una variación es un permiso escrito del regulador para hacer algo que el código normalmente no permite. Aquí pasa por la Comisión de Restaurantes en apelación: $300, una audiencia pública y un aviso en el periódico. Planea no necesitarla."
            ]
        }
    ],
    quiz: {
        passThreshold: 0.85,
        questions: [
            {
                id: "fs7-q1",
                questionEn: "Closing shift, 7:45 PM. Someone knocks with a county ID and asks to inspect. The closer wants to say, \"Come back tomorrow.\" What should happen?",
                questionEs: "Turno de cierre, 7:45 PM. Alguien toca con identificación del condado y pide inspeccionar. El que cierra quiere decir: \"Regrese mañana.\" ¿Qué debe pasar?",
                options: [
                    { id: "a", textEn: "Say to come back during lunch", textEs: "Decirle que regrese a la hora del almuerzo" },
                    { id: "b", textEn: "Check the ID, let them in and call the owner while cooperating", textEs: "Revisar la identificación, dejarlo entrar y llamar al dueño mientras cooperas" },
                    { id: "c", textEn: "Keep the door locked until the owner arrives, since only the owner can allow entry", textEs: "Mantener la puerta cerrada hasta que llegue el dueño, porque solo el dueño puede dejar entrar" },
                    { id: "d", textEn: "Ask for a written appointment first", textEs: "Pedir primero una cita por escrito" }
                ],
                correct: "b"
            },
            {
                id: "fs7-q2",
                questionEn: "The inspector cites a critical item: the rice pan is out of temperature. A coworker says we have until the follow-up to fix it. What's correct?",
                questionEs: "El inspector cita un punto crítico: la charola de arroz está fuera de temperatura. Un compañero dice que tenemos hasta el seguimiento para corregirlo. ¿Qué es correcto?",
                options: [
                    { id: "a", textEn: "We have 72 hours", textEs: "Tenemos 72 horas" },
                    { id: "b", textEn: "We have 90 days", textEs: "Tenemos 90 días" },
                    { id: "c", textEn: "We fix it on the spot", textEs: "Lo corregimos en el momento" },
                    { id: "d", textEn: "We have until the next routine inspection", textEs: "Tenemos hasta la siguiente inspección de rutina" }
                ],
                correct: "c"
            },
            {
                id: "fs7-q3",
                questionEn: "A store scores 85. What does county law require for fixing the items?",
                questionEs: "Una tienda saca 85. ¿Qué exige la ley del condado para corregir los puntos?",
                options: [
                    { id: "a", textEn: "Everything within 30 days", textEs: "Todo en 30 días o menos" },
                    { id: "b", textEn: "Nothing, because 85 is a passing score", textEs: "Nada, porque 85 es un puntaje aprobatorio" },
                    { id: "c", textEn: "Everything within 10 days", textEs: "Todo en 10 días o menos" },
                    { id: "d", textEn: "Only critical items, within 60 days", textEs: "Solo puntos críticos, en 60 días o menos" }
                ],
                correct: "a"
            },
            {
                id: "fs7-q4",
                questionEn: "The inspector downgrades a store. A lead wants to take the placard down until the follow-up. What can that cost?",
                questionEs: "El inspector le baja la calificación a una tienda. Un líder quiere quitar el letrero hasta el seguimiento. ¿Cuánto puede costar eso?",
                options: [
                    { id: "a", textEn: "Nothing, it's up to the store", textEs: "Nada, lo decide la tienda" },
                    { id: "b", textEn: "$25", textEs: "$25" },
                    { id: "c", textEn: "$50", textEs: "$50" },
                    { id: "d", textEn: "A $300 fine", textEs: "Una multa de $300" }
                ],
                correct: "d"
            },
            {
                id: "fs7-q5",
                questionEn: "A store was downgraded twice this calendar year. What happens next for the certified manager?",
                questionEs: "A una tienda le bajaron la calificación dos veces este año calendario. ¿Qué sigue para el gerente certificado?",
                options: [
                    { id: "a", textEn: "Retake the certification exam within 30 days and post the new certificate", textEs: "Volver a tomar el examen de certificación en 30 días y publicar el certificado nuevo" },
                    { id: "b", textEn: "A 2-hour county Food Safety School at $50 per person", textEs: "Una Escuela de Seguridad Alimentaria del condado de 2 horas, a $50 por persona" },
                    { id: "c", textEn: "Automatic loss of the permit", textEs: "Pérdida automática del permiso" },
                    { id: "d", textEn: "Nothing, as long as the fixes are done", textEs: "Nada, mientras se hagan las correcciones" }
                ],
                correct: "b"
            },
            {
                id: "fs7-q6",
                questionEn: "Morning audit: yesterday's 2 PM temperature check is blank in the log. Someone says just to write in 41°F. What do you do?",
                questionEs: "Revisión de la mañana: la revisión de temperatura de ayer a las 2 PM está en blanco. Alguien dice que solo escribas 41°F. ¿Qué haces?",
                options: [
                    { id: "a", textEn: "Write 41°F, since it was probably fine", textEs: "Escribir 41°F, porque probablemente estaba bien" },
                    { id: "b", textEn: "Copy the reading from the check before it, since the temperature rarely changes", textEs: "Copiar la lectura de la revisión anterior, porque la temperatura casi no cambia" },
                    { id: "c", textEn: "Leave it blank, note the gap honestly and fix the habit", textEs: "Dejarlo en blanco, anotar el hueco con honestidad y corregir el hábito" },
                    { id: "d", textEn: "Tear out the page and start over", textEs: "Arrancar la hoja y empezar de nuevo" }
                ],
                correct: "c"
            },
            {
                id: "fs7-q7",
                questionEn: "A new hire has a food handler card and asks if she can cover as the certified person on the morning prep shift. What's the answer?",
                questionEs: "Una empleada nueva tiene tarjeta de manejo de alimentos y pregunta si puede cubrir como la persona certificada en el turno de preparación de la mañana. ¿Cuál es la respuesta?",
                options: [
                    { id: "a", textEn: "No. A handler card doesn't count toward the manager rule", textEs: "No. Una tarjeta de manejo no cuenta para la regla del gerente" },
                    { id: "b", textEn: "Yes, a card is the same as a manager certificate", textEs: "Sí, una tarjeta es igual a un certificado de gerente" },
                    { id: "c", textEn: "Yes, since the store isn't open yet", textEs: "Sí, porque la tienda todavía no abre" },
                    { id: "d", textEn: "Yes, if she finishes all the Food Safety modules, since those teach the same rules", textEs: "Sí, si termina todos los módulos de Seguridad Alimentaria, porque enseñan las mismas reglas" }
                ],
                correct: "a"
            },
            {
                id: "fs7-q8",
                questionEn: "The inspector asks the manager to sign a report she disagrees with. What does signing mean?",
                questionEs: "El inspector le pide a la gerente que firme un reporte con el que no está de acuerdo. ¿Qué significa firmar?",
                options: [
                    { id: "a", textEn: "She admits to every violation", textEs: "Admite todas las violaciones" },
                    { id: "b", textEn: "She gives up the right to a hearing and accepts the score as final", textEs: "Renuncia al derecho a una audiencia y acepta el puntaje como final" },
                    { id: "c", textEn: "She agrees with the score", textEs: "Está de acuerdo con el puntaje" },
                    { id: "d", textEn: "She acknowledges she received it, not that she agrees", textEs: "Reconoce que lo recibió, no que esté de acuerdo" }
                ],
                correct: "d"
            },
            {
                id: "fs7-q9",
                questionEn: "The county puts a hold on a case of pork. It's in the way and a cook wants to move it to the back. What's the rule?",
                questionEs: "El condado retiene una caja de puerco. Estorba y un cocinero quiere pasarla atrás. ¿Cuál es la regla?",
                options: [
                    { id: "a", textEn: "Move it, as long as you label it", textEs: "Moverla, siempre que la etiquetes" },
                    { id: "b", textEn: "Don't use it or move it", textEs: "No usarla ni moverla" },
                    { id: "c", textEn: "Cook it today so it doesn't go to waste", textEs: "Cocinarla hoy para que no se desperdicie" },
                    { id: "d", textEn: "Send it back to the supplier", textEs: "Regresarla al proveedor" }
                ],
                correct: "b"
            },
            {
                id: "fs7-q10",
                questionEn: "A manager has a new vacuum sealer and wants to start bagging cooked pork for the walk-in. What comes first?",
                questionEs: "Un gerente tiene una selladora al vacío nueva y quiere empezar a empacar puerco cocido para el walk-in. ¿Qué va primero?",
                options: [
                    { id: "a", textEn: "A test batch with a label", textEs: "Una tanda de prueba con etiqueta" },
                    { id: "b", textEn: "Nothing, since the pork is already cooked and bagging only makes it last longer", textEs: "Nada, porque el puerco ya está cocido y empacarlo solo hace que dure más" },
                    { id: "c", textEn: "Talk to the county first. Vacuum packing TCS food needs a plan", textEs: "Hablar primero con el condado. Empacar al vacío comida TCS necesita un plan" },
                    { id: "d", textEn: "A note in the Rice Log", textEs: "Una nota en el Registro de Arroz" }
                ],
                correct: "c"
            }
        ]
    }
};

export const FS8_MANAGER_EXAM_STUDY = {
    id: "fs8",
    code: "FS8",
    track: "food-safety",
    tier: "all",
    draft: true,
    icon: "📚",
    durationMin: 40,
    titleEn: "Manager Exam Study",
    titleEs: "Estudio para el Examen de Gerentes",
    lessons: [
        {
            id: "fs8-l1",
            titleEn: "How the exam works",
            titleEs: "Cómo funciona el examen",
            contentEn: [
                "!! WHAT THIS MODULE IS: This module helps you review for the ServSafe® Food Protection Manager exam. It is not affiliated with or endorsed by the National Restaurant Association. Only the proctored exam gives certification. Finishing this module is a DD Mau training record, not a certificate.",
                "| Item | What the public materials say |",
                "| Questions | 90 multiple choice, 80 scored. Blanks count as wrong |",
                "| Time | 2 hours, proctored |",
                "| Certificate | 5 years, subject to local rules. Renew by passing again |",
                "| Retakes | Two tries within 30 days, then at least 60 days between tries. No more than 4 in 12 months |",
                "| Languages | English, Spanish, Chinese, Korean, Japanese and French Canadian, depending on format. Vietnamese isn't listed for the manager exam |",
                "!! PASS MARK UNCONFIRMED: Official sources conflict. Most ServSafe FAQs say 70%. The Examinee Handbook and Pearson VUE say 75%. Confirm with ServSafe before you rely on either, and study well past both.",
                "!! NEVER SHARE EXAM QUESTIONS: The examinee agreement bars disclosing them, and the penalties include revoking your certificate. Don't ask for them and don't pass them on.",
                "## Where our information comes from",
                "We wrote this from FDA and county text. The ServSafe answers here come from its public sheets and posters, some from older editions. Nobody read the 9th Edition book for this module. If you have the book and it says something different, the book wins for the exam. Tell the owner so we can fix this page."
            ],
            contentEs: [
                "!! QUÉ ES ESTE MÓDULO: Este módulo te ayuda a repasar para el examen ServSafe® Food Protection Manager. No está afiliado ni respaldado por la National Restaurant Association. Solo el examen supervisado da la certificación. Terminar este módulo es un registro de capacitación de DD Mau, no un certificado.",
                "| Tema | Lo que dicen los materiales públicos |",
                "| Preguntas | 90 de opción múltiple, 80 con puntaje. Las que dejas en blanco cuentan como mal |",
                "| Tiempo | 2 horas, supervisado |",
                "| Certificado | 5 años, sujeto a reglas locales. Se renueva pasando el examen otra vez |",
                "| Repetir | Dos intentos en 30 días, luego por lo menos 60 días entre intentos. No más de 4 en 12 meses |",
                "| Idiomas | Inglés, español, chino, coreano, japonés y francés canadiense, según el formato. El vietnamita no aparece para el examen de gerentes |",
                "!! NOTA MÍNIMA SIN CONFIRMAR: Las fuentes oficiales no coinciden. La mayoría de las preguntas frecuentes de ServSafe dicen 70%. El Manual del Examinado y Pearson VUE dicen 75%. Confírmalo con ServSafe antes de confiar en cualquiera, y estudia para pasar muy por encima de las dos.",
                "!! NUNCA COMPARTAS PREGUNTAS DEL EXAMEN: El acuerdo del examinado prohíbe revelarlas, y las sanciones incluyen quitarte el certificado. No las pidas ni las pases.",
                "## De dónde viene nuestra información",
                "Escribimos esto a partir de textos de la FDA y del condado. Las respuestas de ServSafe aquí vienen de sus hojas y carteles públicos, algunos de ediciones anteriores. Nadie leyó el libro de la 9ª Edición para este módulo. Si tienes el libro y dice algo distinto, para el examen manda el libro. Avísale al dueño para corregir esta página."
            ]
        },
        {
            id: "fs8-l2",
            titleEn: "Where our rule and the exam differ",
            titleEs: "Dónde difieren nuestra regla y el examen",
            contentEn: [
                "At work, follow our rule. On the exam, give the exam's answer.",
                "| Topic | Our rule | Exam answer |",
                "| Chicken | 165°F for 15 seconds | 165°F for under 1 second |",
                "| Dishes with cooked ingredients | 165°F for 15 seconds | 165°F for under 1 second |",
                "| Ground meat | 155°F for 17 seconds | 155°F for 17 seconds. County also accepts 15 seconds |",
                "| Hand sink water | 100°F or more | 85°F or more |",
                "| Certified manager on site | Every hour the building is occupied, as county practice to confirm | Person in charge certified and on site all operating hours, unless the regulator finds minimal risk |",
                "| Bare hands, food going into a cooked dish | Never. Gloves or a utensil | Allowed for a ready-to-eat item going into that dish |",
                "| Time control start | 41°F or below, or 135°F or above | Cut produce and opened sealed food may start at 70°F or below on 4 hours |",
                "| Holding checks | Every 2 hours, store choice | At least every 4 hours |",
                "| Reportable illnesses | Six, the same as the exam. County text lists five | Six, adding nontyphoidal Salmonella |",
                "| Major allergens | Nine, the same as the exam. County text has no sesame | Nine, with sesame |",
                "| Violation deadlines | Critical items fixed on the spot | Priority 72 hours, Priority Foundation 10 days, Core 90 days. Never treat these as local allowances |",
                "| Glove change | House rule: 4 hours of steady use | Taught as 4 hours of continuous use. It's not in any FDA text |",
                "## Cooling",
                "Exam: 135°F to 70°F in 2 hours. For the second stage, the code says 41°F within 6 hours total. The \"next 4 hours\" wording showed up only in secondary sources. Never cool at room temperature on the exam."
            ],
            contentEs: [
                "En el trabajo, sigue nuestra regla. En el examen, da la respuesta del examen.",
                "| Tema | Nuestra regla | Respuesta de examen |",
                "| Pollo | 165°F por 15 segundos | 165°F por menos de 1 segundo |",
                "| Platillos con ingredientes cocidos | 165°F por 15 segundos | 165°F por menos de 1 segundo |",
                "| Carne molida | 155°F por 17 segundos | 155°F por 17 segundos. El condado también acepta 15 segundos |",
                "| Agua del lavamanos | 100°F o más | 85°F o más |",
                "| Gerente certificado presente | Cada hora que el edificio esté ocupado, como práctica del condado por confirmar | Persona a cargo certificada y presente todas las horas de operación, salvo que el regulador encuentre riesgo mínimo |",
                "| Manos sin guantes, comida que va a un platillo cocido | Nunca. Guantes o utensilio | Se permite con un ingrediente listo para comer que va a ese platillo |",
                "| Inicio de control de tiempo | 41°F o menos, o 135°F o más | Verduras cortadas y comida sellada abierta pueden empezar a 70°F o menos con 4 horas |",
                "| Revisiones de temperatura | Cada 2 horas, decisión de la tienda | Por lo menos cada 4 horas |",
                "| Enfermedades que se avisan | Seis, igual que el examen. El texto del condado lista cinco | Seis, agregando Salmonella no tifoidea |",
                "| Alérgenos principales | Nueve, igual que el examen. El texto del condado no tiene ajonjolí | Nueve, con ajonjolí |",
                "| Plazos de violaciones | Puntos críticos corregidos en el momento | Prioritario 72 horas, Prioritario de Base 10 días, Básico 90 días. Nunca los tomes como permisos locales |",
                "| Cambio de guantes | Regla de la casa: 4 horas de uso seguido | Se enseña como 4 horas de uso continuo. No está en ningún texto de la FDA |",
                "## Enfriamiento",
                "Examen: de 135°F a 70°F en 2 horas. Para la segunda etapa, el código dice 41°F en 6 horas en total. La frase \"siguientes 4 horas\" apareció solo en fuentes secundarias. En el examen, nunca enfríes a temperatura ambiente."
            ]
        },
        {
            id: "fs8-l3",
            titleEn: "Local rules the exam won't teach, and items to check in the book",
            titleEs: "Reglas locales que el examen no enseña, y qué revisar en el libro",
            contentEn: [
                "## County rules ServSafe's public materials don't teach this way",
                "• Hepatitis A proof by day 30",
                "• Letter grades and their bands",
                "• Fix deadlines by score, and the downgrade costs",
                "• Posting the permit, the inspection form and the grade placard",
                "• Calling the county first after an event, with no keep-operating plan",
                "• Lighting at 20, 40 and 75 foot candles. Don't assume the exam uses the same levels",
                "## Check these in the 9th Edition book",
                "| Topic | Why it's unconfirmed |",
                "| Full cooking table | Some rows were seen only on posters |",
                "| Iodine water | 75°F here. 68°F came from a third-party summary |",
                "| Chlorine strength | 50-99 ppm came from a third-party summary |",
                "| Frozen raw over frozen ready-to-eat | FDA's newer code allows it when packaged. ServSafe's teaching is unread |",
                "| Refreezing, freezer and dry storage numbers | Book position unread |",
                "| Lighting levels | FDA's are 10, 20 and 50. The book's are unread |",
                "| Coconut | FDA dropped it from tree nuts. Book position unread |",
                "| Time control approval | Older editions said written approval in advance. The 9th lists procedures and says to consult the regulator |",
                "Don't use the 2026 Food Safety Month Week 5 handouts. They contradict the code and each other. Rely on these tables and the book."
            ],
            contentEs: [
                "## Reglas del condado que los materiales públicos de ServSafe no enseñan así",
                "• Comprobante de hepatitis A para el día 30",
                "• Calificaciones con letra y sus rangos",
                "• Plazos para corregir según el puntaje, y los costos de bajar de calificación",
                "• Publicar el permiso, el formulario de inspección y el letrero de calificación",
                "• Llamar primero al condado después de un evento, sin plan para seguir operando",
                "• Iluminación de 20, 40 y 75 pies-candela. No supongas que el examen usa los mismos niveles",
                "## Revisa esto en el libro de la 9ª Edición",
                "| Tema | Por qué no está confirmado |",
                "| Tabla completa de cocción | Algunas filas solo se vieron en carteles |",
                "| Agua para yodo | 75°F aquí. 68°F vino de un resumen de terceros |",
                "| Fuerza del cloro | 50-99 ppm vino de un resumen de terceros |",
                "| Crudo congelado sobre listo para comer congelado | El código más nuevo de la FDA lo permite si está empacado. No se leyó lo que enseña ServSafe |",
                "| Volver a congelar, números de congelador y almacén seco | No se leyó la posición del libro |",
                "| Niveles de iluminación | Los de la FDA son 10, 20 y 50. Los del libro no se leyeron |",
                "| Coco | La FDA lo quitó de las nueces de árbol. No se leyó la posición del libro |",
                "| Aprobación del control de tiempo | Ediciones anteriores decían aprobación escrita por adelantado. La 9ª lista procedimientos y dice consultar al regulador |",
                "No uses los folletos de la Semana 5 del Mes de la Seguridad Alimentaria 2026. Contradicen el código y se contradicen entre sí. Apóyate en estas tablas y en el libro."
            ]
        },
        {
            id: "fs8-l4",
            titleEn: "Exam science",
            titleEs: "Ciencia para el examen",
            contentEn: [
                "This is for the exam. It has no county citation.",
                "## Four kinds of germs and poisons",
                "Bacteria, viruses, parasites and toxins. Hepatitis A is a virus that survives normal cooking, per ServSafe's sheet.",
                "## What germs need to grow",
                "The exam's memory aid is FAT TOM: food, acidity, temperature, time, oxygen and moisture. Cooked rice sits right in the middle of this: it's food with moisture, and it's dangerous when it's held warm.",
                "| Temperature | Exam meaning |",
                "| 41°F to 135°F | The danger zone |",
                "| 70°F to 125°F | The fastest growth |",
                "!! CHECK THE BOOK: The germ usually linked to cooked rice is Bacillus cereus, a link we only have from a secondary source. We left out the other germ-and-food pairings because they came from study guides only. Learn those from your book.",
                "## Five risk factors",
                "Unsafe sources, inadequate cooking, wrong holding, contaminated equipment and poor hygiene.",
                "## Outbreak",
                "For the exam, an outbreak is 2 or more people with the same symptoms after eating the same food. At work, that's also when you call the county."
            ],
            contentEs: [
                "Esto es para el examen. No tiene cita del condado.",
                "## Cuatro tipos de gérmenes y venenos",
                "Bacterias, virus, parásitos y toxinas. La hepatitis A es un virus que sobrevive a la cocción normal, según la hoja de ServSafe.",
                "## Qué necesitan los gérmenes para crecer",
                "La ayuda para memorizar del examen es FAT TOM: comida, acidez, temperatura, tiempo, oxígeno y humedad. El arroz cocido está justo en medio de esto: es comida con humedad, y es peligroso cuando se mantiene tibio.",
                "| Temperatura | Significado de examen |",
                "| 41°F a 135°F | La zona de peligro |",
                "| 70°F a 125°F | El crecimiento más rápido |",
                "!! REVISA EL LIBRO: El germen que normalmente se relaciona con el arroz cocido es Bacillus cereus, un dato que solo tenemos de una fuente secundaria. Dejamos fuera las otras parejas de germen y comida porque vinieron solo de guías de estudio. Apréndelas en tu libro.",
                "## Cinco factores de riesgo",
                "Fuentes inseguras, cocción inadecuada, mantener mal la temperatura, equipo contaminado y mala higiene.",
                "## Brote",
                "Para el examen, un brote es de 2 o más personas con los mismos síntomas después de comer la misma comida. En el trabajo, también es cuando llamas al condado."
            ]
        },
        {
            id: "fs8-l5",
            titleEn: "Running the system",
            titleEs: "Manejar el sistema",
            contentEn: [
                "The 9th Edition added or expanded these topics. Most aren't in the county code. We teach them so you know them for the exam.",
                "| Topic | What to know |",
                "| Food defense | Employees FIRST: follow the plan, inspect, recognize, secure, tell |",
                "| Food safety culture | 11 culture elements. Know that the exam asks about it |",
                "| Written system | Written, used all hours, shown on request. 8 prerequisite programs and a 6-step active control |",
                "| HACCP | A written plan that identifies hazards and sets limits, checks and records. 7 principles. Learn the list from your book. County: required for reduced oxygen packing and certain special processes |",
                "| Self-inspection | A best practice across 15 areas, mirroring the regulator's form. Build ours from a real county report |",
                "| Training records | Train at hire and regularly, document it, correct at once and retrain repeats |",
                "| Safety Data Sheets | On premises and accessible at all times |",
                "| Shellfish tags | Keep 90 days after the container is emptied, with no mixing. An exam topic, unless a case label says otherwise |",
                "| Raw fish for raw service | Freeze at -4°F for 7 days, keep records 90 days. Only if serving raw |",
                "| Food handler certificate | 40 questions, 3 years, no proctor. It doesn't count toward any county duty |",
                "## Where to look in the book (check your book's contents)",
                "| Our module | Book chapter topic |",
                "| FS1 | The safe food handler |",
                "| FS2 | Forms of contamination |",
                "| FS3 | Purchasing, receiving and storage |",
                "| FS4 and FS5 | Preparation and service |",
                "| FS6 | Facilities, pests, cleaning and sanitizing |",
                "| FS7 | Management systems |"
            ],
            contentEs: [
                "La 9ª Edición agregó o amplió estos temas. La mayoría no están en el código del condado. Los enseñamos para que los conozcas para el examen.",
                "| Tema | Qué saber |",
                "| Defensa de alimentos | Employees FIRST: seguir el plan, inspeccionar, reconocer, asegurar, avisar |",
                "| Cultura de seguridad alimentaria | 11 elementos de cultura. Debes saber que el examen pregunta sobre esto |",
                "| Sistema escrito | Escrito, usado a toda hora, mostrado si se pide. 8 programas de requisitos previos y un control activo de 6 pasos |",
                "| HACCP | Un plan escrito que identifica peligros y fija límites, revisiones y registros. 7 principios. Aprende la lista en tu libro. Condado: se exige para empaque con oxígeno reducido y ciertos procesos especiales |",
                "| Autoinspección | Una buena práctica en 15 áreas, igual que el formulario del regulador. Arma el nuestro con un reporte real del condado |",
                "| Registros de capacitación | Capacita al contratar y con regularidad, documéntalo, corrige de inmediato y vuelve a capacitar a quien repita |",
                "| Hojas de Datos de Seguridad | En el local y a la mano en todo momento |",
                "| Etiquetas de mariscos | Guárdalas 90 días después de vaciar el contenedor, sin mezclar. Tema de examen, salvo que la etiqueta de una caja diga otra cosa |",
                "| Pescado crudo para servir crudo | Congelar a -4°F por 7 días, guardar registros 90 días. Solo si se sirve crudo |",
                "| Certificado de manejo de alimentos | 40 preguntas, 3 años, sin supervisor. No cuenta para ninguna obligación del condado |",
                "## Dónde buscar en el libro (revisa el índice de tu libro)",
                "| Nuestro módulo | Tema del capítulo del libro |",
                "| FS1 | La persona que maneja comida de forma segura |",
                "| FS2 | Formas de contaminación |",
                "| FS3 | Compra, recibo y almacenamiento |",
                "| FS4 y FS5 | Preparación y servicio |",
                "| FS6 | Instalaciones, plagas, limpieza y sanitización |",
                "| FS7 | Sistemas de administración |"
            ]
        }
    ],
    quiz: {
        passThreshold: 0.85,
        questions: [
            {
                id: "fs8-q1",
                questionEn: "EXAM ANSWER: A cook checks a pan of chicken thighs. On the exam, what's the required minimum for poultry?",
                questionEs: "RESPUESTA DE EXAMEN: Un cocinero revisa una charola de muslos de pollo. En el examen, ¿cuál es el mínimo para aves?",
                options: [
                    { id: "a", textEn: "155°F for 17 seconds", textEs: "155°F por 17 segundos" },
                    { id: "b", textEn: "165°F for under 1 second", textEs: "165°F por menos de 1 segundo" },
                    { id: "c", textEn: "145°F for 15 seconds", textEs: "145°F por 15 segundos" },
                    { id: "d", textEn: "135°F with no minimum time", textEs: "135°F sin tiempo mínimo" }
                ],
                correct: "b"
            },
            {
                id: "fs8-q2",
                questionEn: "OUR STORE: Your new shift lead passed the exam and says chicken is done at 165°F with no hold. What do you tell her for the line?",
                questionEs: "EN NUESTRA TIENDA: Tu nueva líder de turno pasó el examen y dice que el pollo está listo a 165°F sin mantenerlo. ¿Qué le dices para la línea?",
                options: [
                    { id: "a", textEn: "She's right, so change the line rule to match what the exam teaches", textEs: "Tiene razón, así que cambia la regla de la línea para que coincida con el examen" },
                    { id: "b", textEn: "That's the exam answer. County law here is 165°F for 15 seconds", textEs: "Esa es la respuesta de examen. La ley del condado aquí es 165°F por 15 segundos" },
                    { id: "c", textEn: "Use 155°F, since it's close", textEs: "Usa 155°F, porque está cerca" },
                    { id: "d", textEn: "Each person can pick their own", textEs: "Cada persona puede escoger" }
                ],
                correct: "b"
            },
            {
                id: "fs8-q3",
                questionEn: "EXAM ANSWER: A manager is setting up a new hand sink. On the exam, what's the minimum water temperature?",
                questionEs: "RESPUESTA DE EXAMEN: Un gerente instala un lavamanos nuevo. En el examen, ¿cuál es la temperatura mínima del agua?",
                options: [
                    { id: "a", textEn: "85°F", textEs: "85°F" },
                    { id: "b", textEn: "100°F", textEs: "100°F" },
                    { id: "c", textEn: "110°F", textEs: "110°F" },
                    { id: "d", textEn: "135°F", textEs: "135°F" }
                ],
                correct: "a"
            },
            {
                id: "fs8-q4",
                questionEn: "EXAM ANSWER: A cook adds washed green onions with bare hands to a pot of broth that will keep cooking. On the exam, is that allowed?",
                questionEs: "RESPUESTA DE EXAMEN: Un cocinero agrega cebollín lavado sin guantes a una olla de caldo que se va a seguir cocinando. En el examen, ¿se permite?",
                options: [
                    { id: "a", textEn: "Yes, it's going into a dish that will be cooked", textEs: "Sí, va a un platillo que se va a cocinar" },
                    { id: "b", textEn: "No, never", textEs: "No, nunca" },
                    { id: "c", textEn: "Only with hand antiseptic", textEs: "Solo con antiséptico" },
                    { id: "d", textEn: "Only with a manager's approval, noted in the log for that shift", textEs: "Solo con aprobación del gerente, anotada en el registro de ese turno" }
                ],
                correct: "a"
            },
            {
                id: "fs8-q5",
                questionEn: "EXAM ANSWER: A store holds cut lettuce on time as a control. On the exam, what's the warmest allowed start for it on a 4-hour limit?",
                questionEs: "RESPUESTA DE EXAMEN: Una tienda mantiene lechuga cortada con tiempo como control. En el examen, ¿cuál es el inicio más tibio permitido con un límite de 4 horas?",
                options: [
                    { id: "a", textEn: "41°F", textEs: "41°F" },
                    { id: "b", textEn: "55°F", textEs: "55°F" },
                    { id: "c", textEn: "70°F", textEs: "70°F" },
                    { id: "d", textEn: "135°F", textEs: "135°F" }
                ],
                correct: "c"
            },
            {
                id: "fs8-q6",
                questionEn: "EXAM ANSWER: A manager asks how often to check hot-held food if it isn't otherwise monitored. What's the exam's answer?",
                questionEs: "RESPUESTA DE EXAMEN: Un gerente pregunta cada cuánto revisar comida caliente si no se vigila de otra forma. ¿Cuál es la respuesta del examen?",
                options: [
                    { id: "a", textEn: "At least every 24 hours", textEs: "Por lo menos cada 24 horas" },
                    { id: "b", textEn: "At least every 6 hours", textEs: "Por lo menos cada 6 horas" },
                    { id: "c", textEn: "Only at open and close", textEs: "Solo al abrir y al cerrar" },
                    { id: "d", textEn: "At least every 4 hours", textEs: "Por lo menos cada 4 horas" }
                ],
                correct: "d"
            },
            {
                id: "fs8-q7",
                questionEn: "EXAM ANSWER: A worker has a lab-confirmed illness. Which group is the exam's full list of six?",
                questionEs: "RESPUESTA DE EXAMEN: Un trabajador tiene una enfermedad confirmada por laboratorio. ¿Qué grupo es la lista completa de seis del examen?",
                options: [
                    { id: "a", textEn: "Norovirus, hepatitis A, Shigella, Shiga toxin E. coli, Salmonella Typhi, nontyphoidal Salmonella", textEs: "Norovirus, hepatitis A, Shigella, E. coli de toxina Shiga, Salmonella Typhi, Salmonella no tifoidea" },
                    { id: "b", textEn: "Norovirus, the flu, Shigella, a cold, Salmonella Typhi, strep throat", textEs: "Norovirus, gripe, Shigella, resfriado, Salmonella Typhi, faringitis" },
                    { id: "c", textEn: "Hepatitis A, hepatitis B, hepatitis C, norovirus, Shigella and Shiga toxin E. coli", textEs: "Hepatitis A, hepatitis B, hepatitis C, norovirus, Shigella y E. coli de toxina Shiga" },
                    { id: "d", textEn: "Only norovirus and hepatitis A, listed three ways", textEs: "Solo norovirus y hepatitis A, listadas de tres formas" }
                ],
                correct: "a"
            },
            {
                id: "fs8-q8",
                questionEn: "EXAM ANSWER: Two guests at different tables have the same stomach symptoms after eating the same dish. On the exam, what is this?",
                questionEs: "RESPUESTA DE EXAMEN: Dos clientes en mesas distintas tienen los mismos síntomas de estómago después de comer el mismo platillo. En el examen, ¿qué es esto?",
                options: [
                    { id: "a", textEn: "A coincidence until 5 people report it", textEs: "Una coincidencia hasta que 5 personas lo reporten" },
                    { id: "b", textEn: "A risk factor", textEs: "Un factor de riesgo" },
                    { id: "c", textEn: "An outbreak", textEs: "Un brote" },
                    { id: "d", textEn: "A cross-contact event", textEs: "Un evento de contacto cruzado" }
                ],
                correct: "c"
            },
            {
                id: "fs8-q9",
                questionEn: "EXAM ANSWER: A trainee leaves question 40 blank when time runs out. How does the exam score it?",
                questionEs: "RESPUESTA DE EXAMEN: Un aprendiz deja la pregunta 40 en blanco cuando se acaba el tiempo. ¿Cómo la califica el examen?",
                options: [
                    { id: "a", textEn: "It's left out of the score", textEs: "No se cuenta en el puntaje" },
                    { id: "b", textEn: "It counts as wrong", textEs: "Cuenta como mal" },
                    { id: "c", textEn: "It counts as half credit", textEs: "Cuenta como la mitad" },
                    { id: "d", textEn: "It gets moved to a retake", textEs: "Se pasa a otro intento" }
                ],
                correct: "b"
            },
            {
                id: "fs8-q10",
                questionEn: "A shift lead asks what pass mark to plan on. One official page says 70%, and another says 75%. What's the honest answer?",
                questionEs: "Un líder de turno pregunta qué nota mínima debe esperar. Una página oficial dice 70% y otra dice 75%. ¿Cuál es la respuesta honesta?",
                options: [
                    { id: "a", textEn: "It's definitely 70%", textEs: "Definitivamente es 70%" },
                    { id: "b", textEn: "It's definitely 75%", textEs: "Definitivamente es 75%" },
                    { id: "c", textEn: "It doesn't matter much, because the exam is graded on a curve each time", textEs: "No importa mucho, porque el examen se califica en curva cada vez" },
                    { id: "d", textEn: "Sources conflict. Confirm with ServSafe and study well past both", textEs: "Las fuentes no coinciden. Confirma con ServSafe y estudia para pasar muy por encima de las dos" }
                ],
                correct: "d"
            },
            {
                id: "fs8-q11",
                questionEn: "A coworker who just took the exam offers to tell you the questions he remembers. What do you do?",
                questionEs: "Un compañero que acaba de tomar el examen te ofrece decirte las preguntas que recuerda. ¿Qué haces?",
                options: [
                    { id: "a", textEn: "Say no. Sharing them breaks the examinee agreement", textEs: "Decir que no. Compartirlas rompe el acuerdo del examinado" },
                    { id: "b", textEn: "Write them all down for the next person", textEs: "Anotarlas todas para el siguiente" },
                    { id: "c", textEn: "Listen, but only if he swears they came from an older edition of the exam", textEs: "Oírlas, pero solo si jura que vienen de una edición anterior del examen" },
                    { id: "d", textEn: "Only listen to the hardest ones", textEs: "Oír solo las más difíciles" }
                ],
                correct: "a"
            },
            {
                id: "fs8-q12",
                questionEn: "You finished all eight Food Safety modules with a passing score. A guest asks if you're a certified food protection manager. What's true?",
                questionEs: "Terminaste los ocho módulos de Seguridad Alimentaria con puntaje aprobatorio. Un cliente pregunta si eres gerente certificado en protección de alimentos. ¿Qué es cierto?",
                options: [
                    { id: "a", textEn: "Yes, since the modules count for 5 years, the same as the exam certificate", textEs: "Sí, porque los módulos cuentan por 5 años, igual que el certificado del examen" },
                    { id: "b", textEn: "Yes, at DD Mau stores only", textEs: "Sí, solo en las tiendas de DD Mau" },
                    { id: "c", textEn: "No. Only the proctored exam gives certification", textEs: "No. Solo el examen supervisado da la certificación" },
                    { id: "d", textEn: "Yes, if you also hold a food handler card", textEs: "Sí, si también tienes tarjeta de manejo de alimentos" }
                ],
                correct: "c"
            }
        ]
    }
};

export const FOOD_SAFETY_MODULES = [
    FS1_CLEAN_HANDS,
    FS2_ALLERGENS,
    FS3_DELIVERY_TO_STORAGE,
    FS4_COOKING,
    FS5_COOLING_HOLDING,
    FS6_CLEANING_EMERGENCIES,
    FS7_INSPECTIONS,
    FS8_MANAGER_EXAM_STUDY
];
