// DD Mau training modules — schema v2.
//
// Each module: id, code, titleEn/Es, icon, track (new-hire | stations | menu |
// service-safety | manager-ops), tier (all | lead | admin), durationMin,
// lessons[], quiz{ passThreshold, questions[] }.
//
// Each lesson: id, titleEn/Es, contentEn/Es. Content is an array of paragraphs
// — the renderer joins with double-newline.
//
// Quiz: passThreshold is a fraction (0.8 = 80%). Each question has an id,
// questionEn/Es, options[{id,textEn,textEs}], and correct id. Two consecutive
// failed attempts lock the module — manager must clear the lock from the
// admin panel before the staff can retry.
//
// ── HOW TO EDIT LESSON CONTENT ─────────────────────────────────────────
// This file is the DEPLOYED DEFAULT. At runtime TrainingHub.jsx layers
// per-lesson overrides from Firestore (/config/training_overrides) on
// top of these arrays via applyLessonOverride(). Admins edit lessons
// in the app — there's a ✏️ Edit button on every lesson visible to
// isAdmin() users that writes to that doc, and the change propagates
// to every device in ~1 second.
//
// DO edit this file for: structural changes (new modules, new lessons,
// quiz question lists, fields like `tier`/`track`/`durationMin`,
// allergen-matrix data tables). Anything not covered by the in-app
// editor lives here.
//
// DON'T edit this file for: typo fixes, wording polish, or any
// in-the-moment text tweak. Use the in-app Edit button — it survives
// a redeploy of this file (override still applies on top of new baseline)
// and doesn't require waiting on GitHub Pages.
//
// HISTORICAL NOTE: an earlier round-trip workflow (scripts/export-
// training.mjs + scripts/import-training.mjs + TRAINING_EDIT.md) was
// retired in 2026-05-15 because it competed with the in-app overrides.
// A stale markdown import would silently clobber the baseline this
// file represents, and the export script didn't know about Firestore
// overrides — so the round-trip created a foot-gun pair. The in-app
// Edit button is now the only sanctioned text-edit path.

export const MODULES = [
    {
        id: "m1",
        code: "M1",
        track: "new-hire",
        tier: "all",
        icon: "👋",
        durationMin: 15,
        titleEn: "Welcome to DD Mau",
        titleEs: "Bienvenido a DD Mau",
        lessons: [
            {
                id: "m1-l1",
                titleEn: "Welcome to the DD Mau Family",
                titleEs: "Bienvenido a la Familia DD Mau",
                contentEn: [
                    "Hey — welcome to DD Mau. Whether this is your first restaurant gig or you've been on a line for years, we're glad to have you.",
                    "DD Mau isn't a sit-down place and it isn't a drive-through. We live in the sweet spot where amazing Vietnamese food meets quick, energetic service. Think of us as Vietnamese street food, elevated, with hospitality to match.",
                    "Our name means 'hurry up' in Vietnamese — because great food and great service shouldn't take forever.",
                    "What we expect from you: bring your real personality. Be warm, be fast, be honest. Read these training modules end to end — they cover everything from greeting a guest to cleaning a sink after raw chicken. Then go apply it on the floor.",
                    "What you can expect from us: a clean kitchen, fair tips, real coaching, and a team that has your back when it gets crazy."
                ],
                contentEs: [
                    "Bienvenido a DD Mau. Sea este tu primer trabajo en un restaurante o que tengas años de experiencia, nos alegra tenerte en el equipo.",
                    "DD Mau no es un restaurante de mesa ni un drive-through. Estamos en el punto medio donde la comida vietnamita increíble se encuentra con un servicio rápido y enérgico. Somos comida callejera vietnamita, elevada, con hospitalidad a la altura.",
                    "Nuestro nombre significa 'apúrate' en vietnamita — porque la buena comida y el buen servicio no deben tardar.",
                    "Lo que esperamos de ti: trae tu personalidad real. Sé cálido, sé rápido, sé honesto. Lee estos módulos completos — cubren todo, desde saludar a un cliente hasta limpiar un fregadero después del pollo crudo. Después aplícalo en el piso.",
                    "Lo que puedes esperar de nosotros: cocina limpia, propinas justas, entrenamiento real y un equipo que te respalda cuando todo se pone intenso."
                ]
            },
            {
                id: "m1-l2",
                titleEn: "Our Story & Two Locations",
                titleEs: "Nuestra Historia y Dos Ubicaciones",
                contentEn: [
                    "DD Mau was founded by Julie Truong. She opened our first location in Maryland Heights in 2018 with a simple dream — bring authentic, fast-casual Vietnamese food to St. Louis.",
                    "Today we run two locations: Maryland Heights (MH) and Webster Groves (WG). You may be hired for one location or both — either way, our standards are the same. The way you greet a guest, build a bowl, and close the kitchen should look identical at both stores.",
                    "Both locations are fast casual. Guests order at the counter. We run the food to the table. We don't serve at the table the way a sit-down spot does, and we don't have a drive-through window. We move like a counter-service spot but we treat guests like a sit-down spot."
                ],
                contentEs: [
                    "DD Mau fue fundado por Julie Truong. Ella abrió nuestra primera ubicación en Maryland Heights en 2018 con un sueño simple — traer comida vietnamita auténtica y casual rápida a St. Louis.",
                    "Hoy operamos dos ubicaciones: Maryland Heights (MH) y Webster Groves (WG). Puedes ser contratado para una sucursal o para las dos — de cualquier forma, nuestros estándares son iguales. La forma de saludar al cliente, armar un bowl y cerrar la cocina debe verse igual en ambas sucursales.",
                    "Ambas son casual rápido. Los clientes ordenan en el mostrador. Nosotros llevamos la comida a la mesa. No servimos en la mesa como un restaurante de mesa, y no tenemos ventanilla drive-through. Nos movemos como un servicio de mostrador pero tratamos a los clientes como en un restaurante de mesa."
                ]
            },
            {
                id: "m1-l3",
                titleEn: "What Makes DD Mau Different",
                titleEs: "Qué Hace Diferente a DD Mau",
                contentEn: [
                    "Three things make us different and they are non-negotiable. Hospitality comes first — the food and the speed only matter if the guest feels seen.",
                    "1. Hospitality is everything. We're a counter-service spot, but we are not a transaction machine. Eye contact. A smile. Greet the guest in 10 seconds. Read the room. The difference between a guest who comes back and one who doesn't is almost always how you made them feel — not the food.",
                    "2. Fresh meets fast. The pho broth simmered overnight. The vinaigrette was made this week. The egg rolls were rolled by hand in the back. Speed comes from prep, organization, and station discipline — not from cutting corners.",
                    "3. Vietnamese street food, elevated. Our menu is built on traditional Vietnamese flavors — fish sauce, lemongrass, fresh herbs, rice noodles, banh mi — but we plate them for a fast-casual setting. The flavors are real. The presentation is sharp. The price is fair."
                ],
                contentEs: [
                    "Tres cosas nos hacen diferentes y no son negociables. La hospitalidad va primero — la comida y la velocidad solo importan si el cliente se siente visto.",
                    "1. La hospitalidad lo es todo. Somos servicio de mostrador, pero no somos una máquina de transacciones. Contacto visual. Sonrisa. Saluda al cliente en 10 segundos. Lee la sala. La diferencia entre un cliente que regresa y uno que no, casi siempre es cómo lo hiciste sentir — no la comida.",
                    "2. Fresco y rápido. El caldo de pho se cocinó toda la noche. La vinagreta se hizo esta semana. Los egg rolls se enrollaron a mano en la parte de atrás. La velocidad viene del prep, la organización y la disciplina de estación — no de tomar atajos.",
                    "3. Comida callejera vietnamita, elevada. Nuestro menú se construye sobre sabores vietnamitas tradicionales — salsa de pescado, hierba limón, hierbas frescas, fideos de arroz, banh mi — pero los presentamos para un ambiente casual rápido. Los sabores son reales. La presentación es nítida. El precio es justo."
                ]
            },
            {
                id: "m1-l4",
                titleEn: "Service Frameworks You Will Hear",
                titleEs: "Marcos de Servicio Que Escucharás",
                contentEn: [
                    "We use shared language so every team member is on the same page. You'll hear these phrases in every DD Mau manual and in pre-shift huddles. The deep dive is the FOH Customer Service Training Manual — your trainer will give you a copy; read it before your first solo shift. For now, learn the names so you recognize them when a teammate or Shift Lead uses them on the floor.",
                    "🌟 The 10-Second Rule — every guest gets acknowledged within 10 seconds of walking in. Eye contact, smile, 'Welcome to DD Mau.' Even if you can't take their order yet, you make sure they know you saw them.",
                    "✨ The Bright 4 — four phrases that cover what good service looks like:",
                    "• Eyes Up — scan for guests, don't stare at the register.",
                    "• Light Up — smile when they walk in.",
                    "• Speak Up — greet them out loud, with energy. Flat, monotone service kills the vibe.",
                    "• Show Up — stay present after the greeting: anticipate needs, restock, run food, check the line, check the tables — without being asked.",
                    "🛟 RESTORE — our service-recovery framework for when something goes wrong: Recognize, Empathize, Solve it now, Tell the Lead, Offer something extra, Re-greet, Examine. We walk through it in the FOH Customer Service Training Manual, in pre-shift huddles, and in team meetings. The short version: when a guest complains, do not argue and do not blame the kitchen. Take ownership of the guest, then get the Shift Lead — they own the RESTORE call, and only a Lead can comp or refund. Make it right.",
                    "📣 Kitchen Calls — the words we shout so nobody collides with hot food: 'Behind!' (I'm walking behind you), 'Corner!' (rounding a blind corner), 'Hands!' (I need someone to grab a plate), '86'd!' (we're out of it — stop selling it), 'All day' (total across all tickets — '4 pho all day').",
                    "These frameworks together cover ~90% of what 'good service' looks like at DD Mau. Memorize the names now. We'll work the details into your bones over your first 30 days."
                ],
                contentEs: [
                    "Usamos un lenguaje compartido para que todo el equipo esté en la misma página. Escucharás estas frases en cada manual de DD Mau y en cada reunión de pre-turno. El detalle completo está en el Manual de Servicio al Cliente FOH — tu entrenador te dará una copia; léelo antes de tu primer turno solo. Por ahora, aprende los nombres para reconocerlos cuando un compañero o líder de turno los use en el piso.",
                    "🌟 La Regla de los 10 Segundos — todo cliente debe ser reconocido en los primeros 10 segundos de entrar. Contacto visual, sonrisa, 'Bienvenido a DD Mau.' Aunque no puedas tomarle la orden todavía, debe saber que lo viste.",
                    "✨ Los Bright 4 — cuatro frases que cubren cómo se ve un buen servicio:",
                    "• Ojos Arriba — escanea el local buscando clientes, no te quedes fijo en la caja.",
                    "• Cara Iluminada — sonríe cuando entren.",
                    "• Habla Alto — salúdalos en voz alta y con energía. Un servicio plano y monótono mata el ambiente.",
                    "• Aparece — sigue presente después del saludo: anticipa lo que necesitan, reabastece, lleva comida, revisa la línea, revisa las mesas — sin que te lo pidan.",
                    "🛟 RESTORE — nuestro marco de recuperación de servicio para cuando algo sale mal: Reconocer (Recognize), Empatizar (Empathize), Solucionar ahora (Solve it now), Avisar al líder (Tell the Lead), Ofrecer algo extra (Offer something extra), Re-saludar (Re-greet), Examinar (Examine). Lo repasamos en el Manual de Servicio al Cliente FOH, en las reuniones de pre-turno y en las reuniones de equipo. La versión corta: cuando un cliente se queja, no discutas y no culpes a la cocina. Hazte cargo del cliente y busca al líder de turno — la decisión de RESTORE es suya, y solo un líder puede dar una cortesía (comp) o un reembolso. Arréglalo.",
                    "📣 Kitchen Calls — las palabras que gritamos para que nadie choque con comida caliente: '¡Behind!' (voy detrás de ti), '¡Corner!' (voy a dar vuelta en una esquina ciega), '¡Hands!' (necesito que alguien tome un plato), '¡86'd!' (se acabó — ya no se vende), 'All day' (el total sumando todos los tickets — '4 pho all day').",
                    "Estos marcos juntos cubren ~90% de cómo se ve un 'buen servicio' en DD Mau. Memoriza los nombres ahora. Los detalles se te grabarán en los primeros 30 días."
                ]
            }
        ],
        quiz: {
            passThreshold: 0.8,
            questions: [
                {
                    id: "m1-q1",
                    questionEn: "What does 'DD Mau' mean in Vietnamese?",
                    questionEs: "¿Qué significa 'DD Mau' en vietnamita?",
                    options: [
                        {
                            id: "a",
                            textEn: "Hurry up",
                            textEs: "Apúrate"
                        },
                        {
                            id: "b",
                            textEn: "Welcome",
                            textEs: "Bienvenido"
                        },
                        {
                            id: "c",
                            textEn: "Delicious",
                            textEs: "Delicioso"
                        },
                        {
                            id: "d",
                            textEn: "Family",
                            textEs: "Familia"
                        }
                    ],
                    correct: "a"
                },
                {
                    id: "m1-q2",
                    questionEn: "DD Mau is best described as:",
                    questionEs: "DD Mau se describe mejor como:",
                    options: [
                        {
                            id: "a",
                            textEn: "A drive-through",
                            textEs: "Un drive-through"
                        },
                        {
                            id: "b",
                            textEn: "A fine dining sit-down restaurant",
                            textEs: "Un restaurante elegante con servicio a la mesa"
                        },
                        {
                            id: "c",
                            textEn: "A fast-casual Vietnamese counter-service spot",
                            textEs: "Un lugar casual rápido vietnamita de mostrador"
                        },
                        {
                            id: "d",
                            textEn: "A food truck",
                            textEs: "Un food truck"
                        }
                    ],
                    correct: "c"
                },
                {
                    id: "m1-q3",
                    questionEn: "Within how many seconds should every guest be acknowledged when they walk in?",
                    questionEs: "¿Dentro de cuántos segundos se debe reconocer a cada cliente cuando entra?",
                    options: [
                        {
                            id: "a",
                            textEn: "30 seconds",
                            textEs: "30 segundos"
                        },
                        {
                            id: "b",
                            textEn: "10 seconds",
                            textEs: "10 segundos"
                        },
                        {
                            id: "c",
                            textEn: "60 seconds",
                            textEs: "60 segundos"
                        },
                        {
                            id: "d",
                            textEn: "Whenever you finish what you're doing",
                            textEs: "Cuando termines lo que haces"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m1-q4",
                    questionEn: "What are the four words of the 'Bright 4'?",
                    questionEs: "¿Cuáles son las cuatro palabras de los 'Bright 4'?",
                    options: [
                        {
                            id: "a",
                            textEn: "Eyes Up, Light Up, Speak Up, Show Up",
                            textEs: "Ojos Arriba, Cara Iluminada, Habla Alto, Aparece"
                        },
                        {
                            id: "b",
                            textEn: "Smile, Speak, Serve, Sweep",
                            textEs: "Sonríe, Habla, Sirve, Barre"
                        },
                        {
                            id: "c",
                            textEn: "Hurry Up, Stand Up, Speak Up, Show Up",
                            textEs: "Apúrate, Levántate, Habla, Aparece"
                        },
                        {
                            id: "d",
                            textEn: "Listen, Look, Lead, Learn",
                            textEs: "Escucha, Mira, Lidera, Aprende"
                        }
                    ],
                    correct: "a"
                },
                {
                    id: "m1-q5",
                    questionEn: "RESTORE is used when:",
                    questionEs: "RESTORE se usa cuando:",
                    options: [
                        {
                            id: "a",
                            textEn: "Opening the restaurant",
                            textEs: "Abriendo el restaurante"
                        },
                        {
                            id: "b",
                            textEn: "Something goes wrong with a guest",
                            textEs: "Algo sale mal con un cliente"
                        },
                        {
                            id: "c",
                            textEn: "Closing the cash drawer",
                            textEs: "Cerrando la caja"
                        },
                        {
                            id: "d",
                            textEn: "Restocking the boba station",
                            textEs: "Reabasteciendo la estación de boba"
                        }
                    ],
                    correct: "b"
                }
            ]
        }
    },
    {
        id: "m2",
        code: "M2",
        track: "new-hire",
        tier: "all",
        icon: "📋",
        durationMin: 15,
        titleEn: "Day 1 Logistics",
        titleEs: "Logística del Día 1",
        lessons: [
            {
                id: "m2-l1",
                titleEn: "Paperwork & Onboarding",
                titleEs: "Papeleo e Incorporación",
                contentEn: [
                    "Before you ever touch food, money, or speak to guests, here's the paperwork.",
                    "What you'll fill out in the app: W-4 (federal + Missouri), I-9 (work eligibility), direct deposit form (plus a photo of a voided check or bank letter), the Employee Handbook and Wage & Tip Pool acknowledgments, and a photo of your Hepatitis A vaccination record. Your manager will send you the link on (or before) Day 1.",
                    "Bring two forms of ID to your first shift: passport OR driver's license + Social Security card or birth certificate. Without ID we cannot put you on the schedule.",
                    "You'll get a 4-digit Toast POS PIN from your manager. This PIN is yours alone — it's also how you log into the DD Mau app. Do NOT share it with anyone. Voids and time clock punches are tied to your PIN.",
                    "Sign the DD Mau Employee Handbook acknowledgment — it's part of your onboarding paperwork in the app. Your manager keeps the signed copy in your file."
                ],
                contentEs: [
                    "Antes de tocar comida, manejar dinero o atender clientes, esto es el papeleo.",
                    "Lo que vas a llenar en la app: W-4 (federal + Missouri), I-9 (elegibilidad de trabajo), formulario de depósito directo (más una foto de un cheque cancelado o carta del banco), los acuses del Manual del Empleado y del Aviso de Salario y Propinas, y una foto de tu registro de vacuna de Hepatitis A. Tu gerente te enviará el enlace el Día 1 (o antes).",
                    "Trae dos formas de identificación a tu primer turno: pasaporte O licencia de manejar + tarjeta de Seguro Social o acta de nacimiento. Sin ID no podemos ponerte en el horario.",
                    "Vas a recibir un PIN de 4 dígitos de Toast POS de tu gerente. Este PIN es solo tuyo — también es con el que entras a la app de DD Mau. NO lo compartas con nadie. Los voids y las marcas del reloj están atados a tu PIN.",
                    "Firma el acuse de recibo del Manual del Empleado de DD Mau — es parte de tu papeleo de ingreso en la app. Tu gerente guarda la copia firmada en tu archivo."
                ]
            },
            {
                id: "m2-l2",
                titleEn: "Schedule, Time Clock, Breaks",
                titleEs: "Horario, Reloj de Tiempo, Descansos",
                contentEn: [
                    "Schedule. Shifts post weekly. Check the Schedule tab in the DD Mau app at least 48 hours before your next shift. Time-off requests and shift swaps go through the app too (swaps need manager approval). If you spot a conflict, message your manager immediately — not the night before.",
                    "Show up 10 minutes early. Showing up 'on time' really means showing up 10 minutes early. That gives you time to put on your apron, wash hands, and get a quick read of the floor before you clock in.",
                    "Clock in on Toast at the start of your shift, AFTER you are in uniform and ready to work the floor — not before. Clocking in while changing or eating breakfast is not allowed.",
                    "Clock out at the end of your shift, AFTER all your closing duties are signed off by the Shift Lead. If you forgot to clock in or out, tell the Lead immediately so they can correct it. You can also check your punches any time in the My Hours tab of the app and file a fix request there if something's off.",
                    "Breaks. Every double shift gets a 1-hour unpaid break. Always check with the Shift Lead before you take your break — they will have the break schedule planned out."
                ],
                contentEs: [
                    "Horario. Los turnos se publican semanalmente. Revisa la pestaña Horario en la app de DD Mau al menos 48 horas antes de tu siguiente turno. Las solicitudes de tiempo libre y los cambios de turno también se hacen en la app (los cambios necesitan aprobación del gerente). Si detectas un conflicto, escríbele a tu gerente inmediatamente — no la noche anterior.",
                    "Llega 10 minutos temprano. Llegar 'a tiempo' realmente significa llegar 10 minutos temprano. Eso te da tiempo para ponerte el delantal, lavarte las manos, y leer el piso antes de marcar entrada.",
                    "Marca entrada en Toast al inicio de tu turno, DESPUÉS de estar en uniforme y listo para trabajar — no antes. Marcar entrada mientras te cambias o desayunas no está permitido.",
                    "Marca salida al final de tu turno, DESPUÉS de que el líder firme tus deberes de cierre. Si olvidaste marcar entrada o salida, dile al líder inmediatamente para que lo corrija. También puedes revisar tus marcas cuando quieras en la pestaña Mis Horas de la app y pedir una corrección ahí si algo está mal.",
                    "Descansos. Cada turno doble recibe un descanso de 1 hora sin pagar. Siempre revisa con el líder antes de tomar tu descanso — el líder ya tendrá planeado el horario de descansos."
                ]
            },
            {
                id: "m2-l3",
                titleEn: "Dress Code & Hygiene",
                titleEs: "Código de Vestimenta e Higiene",
                contentEn: [
                    "Dress code first, hygiene second. Both matter — guests read both the moment you greet them at the counter.",
                    "DRESS CODE",
                    "• Clean DD Mau shirt — no stains. If your shirt has a stain that won't come out, talk to your manager about a replacement.",
                    "• Pants — dark or khaki. No rips, no holes, no designs or graphics. No yoga pants/leggings. Shorts are fine (clean, no rips, no graphics).",
                    "• Non-slip, closed-toe shoes — REQUIRED, no exceptions. This is a safety rule, not a fashion rule. Wet kitchen floors are how people break wrists.",
                    "• Hair tied back and secured. If it touches your collar, it goes up.",
                    "• Beards must be neat and short, or use a beard guard.",
                    "• Trimmed, clean nails. No acrylics — food safety rule: acrylics hide bacteria and can chip off into food. If you wear polish, it must be fresh and unchipped — chipped polish ends up in food.",
                    "• Minimal jewelry. A wedding band and small stud earrings are fine. Nothing dangling. Nothing that could fall into food.",
                    "PERSONAL HYGIENE — DAILY",
                    "• Show up guest-ready. No body odor, fresh breath, clean face and hands. You're closer to guests than you think — they notice immediately.",
                    "• Light deodorant. Skip cologne or perfume — strong scents kill the food experience for guests.",
                    "ON THE FLOOR",
                    "• No eating on the floor. Drinks stay out of sight — under the counter, in the back, never on top of a station or anywhere a guest can see.",
                    "• No gum chewing on the floor.",
                    "• No tasting food with your fingers. Use a clean spoon, and never double-dip the same spoon.",
                    "• Cover coughs and sneezes into your elbow, turn away from food and people, then wash your hands.",
                    "• Don't touch your face, hair, teeth, ears, or eyes on the floor. If you do, wash your hands before touching food again.",
                    "• Don't share drinks, vapes, or utensils between coworkers."
                ],
                contentEs: [
                    "Primero el código de vestimenta, segundo la higiene. Ambos importan — el cliente los lee en el momento en que lo saludas en el mostrador.",
                    "CÓDIGO DE VESTIMENTA",
                    "• Camisa de DD Mau limpia — sin manchas. Si tu camisa tiene una mancha que no sale, habla con tu gerente sobre un reemplazo.",
                    "• Pantalones — oscuros o khaki. Sin rasgaduras, sin hoyos, sin diseños ni estampados. Nada de yoga pants/leggings. Los shorts están bien (limpios, sin rasgaduras, sin estampados).",
                    "• Zapatos antideslizantes y cerrados — OBLIGATORIO, sin excepciones. Es regla de seguridad, no de moda. En los pisos mojados de la cocina es donde la gente se rompe la muñeca.",
                    "• Cabello recogido y asegurado. Si toca el cuello, va arriba.",
                    "• Las barbas deben estar cortas y arregladas, o usar protector de barba.",
                    "• Uñas cortas y limpias. Sin acrílicos — regla de seguridad alimentaria: los acrílicos esconden bacterias y se pueden desprender en la comida. Si usas esmalte, debe estar fresco y sin descascarar — el esmalte descascarado termina en la comida.",
                    "• Joyería mínima. Un anillo de matrimonio y aretes de botón pequeños están bien. Nada colgante. Nada que pueda caer a la comida.",
                    "HIGIENE PERSONAL — DIARIO",
                    "• Llega listo para los clientes. Sin olor corporal, aliento fresco, cara y manos limpias. Estás más cerca de los clientes de lo que crees — notan al instante.",
                    "• Desodorante ligero. Sin colonia ni perfume — los olores fuertes arruinan la experiencia para los clientes.",
                    "EN EL PISO",
                    "• No comer en el piso. Las bebidas se quedan fuera de la vista — debajo del mostrador, en la parte de atrás, nunca encima de una estación ni donde un cliente pueda verlas.",
                    "• No mascar chicle en el piso.",
                    "• No probar comida con los dedos. Usa una cuchara limpia, y nunca vuelvas a meter la misma cuchara.",
                    "• Cubre tos y estornudos con el codo, voltéate de la comida y de la gente, luego lávate las manos.",
                    "• No te toques la cara, cabello, dientes, oídos ni ojos en el piso. Si lo haces, lávate las manos antes de tocar comida otra vez.",
                    "• No compartas bebidas, vapes ni utensilios entre compañeros."
                ]
            },
            {
                id: "m2-l4",
                titleEn: "Phones, Calling Out, Pay",
                titleEs: "Teléfonos, Avisar Falta, Pago",
                contentEn: [
                    "Phone Policy. Phones stay in the back during your shift. Period. If you need to check something urgently, ask the Shift Lead and step off the floor. No phones at the register, expo, or boba station — guests notice immediately. That includes AirPods/earbuds — none visible when you're out on the floor or in the dining room.",
                    "Emergency? Tell the Shift Lead. We will work it out. Family emergency, sick kid, childcare falling through — we are not heartless, we just need to know.",
                    "Calling Out. If you cannot make a shift, call your manager as soon as you know — not 10 minutes before clock-in — and try to find your own replacement (the swap still needs manager approval). Text AND call — a text alone doesn't count until someone confirms it. The earlier you call, the easier it is to cover. A no-call/no-show is one of the few things that gets you let go fast at DD Mau.",
                    "Tardiness. Late is late. If your shift starts at 11:00, we expect you on the floor and ready at 11:00 — not walking in to start changing. There is no free grace period.",
                    "If you know you'll be late, text or call the Shift Lead the moment you know — in the car, at the door, whatever. Sooner is always better; it lets us shift positions to cover. Communicating doesn't excuse being late, but 'late + told us' is much better than 'late + radio silence.' Very late with no word from you is treated as a no-call/no-show.",
                    "How tardiness is tracked — rolling 60-day window:",
                    "• 1st late = noted in your file, no formal warning.",
                    "• 2nd late within 60 days = written warning. You sign it.",
                    "• 3rd late within 60 days = final written warning + meeting with the GM.",
                    "• 4th late within 60 days = termination.",
                    "Hard limits, regardless of strike count:",
                    "• 30+ minutes late without communicating ahead = automatic written warning.",
                    "• 3 lates in any 30-day window = automatic written warning + GM check-in. We catch the 'always 5 minutes late' pattern early.",
                    "This strike system is how the handbook's tardiness rule is applied day to day. Repeated or excessive lateness is still grounds for termination — the strikes just make the path predictable.",
                    "Why we run it this way: one bad commute shouldn't end a job. But a pattern of being late steals from the rest of the team — they cover your station, stay later. The strike system gives you a real chance to course-correct after the first miss.",
                    "Pay. Pay periods are bi-weekly. Direct deposit lands on Friday. If your paycheck is wrong — wrong hours, missing tips, anything — talk to your General Manager FIRST. Do not wait. Payroll fixes are fastest within the same pay period.",
                    "Tip Pool. Tips are pooled and split 50% Front of House / 50% Back of House. Why 50/50? Because most of our tips come from to-go orders ordered online — those orders feed both sides equally, so they're split evenly. Within each side, tips are distributed by hours worked during the pay period. Owners will never participate in the tip pool."
                ],
                contentEs: [
                    "Política de Teléfonos. Los teléfonos se quedan en la parte de atrás durante tu turno. Punto. Si necesitas revisar algo urgente, pídele permiso al líder y sal del piso. Sin teléfonos en caja, expo ni estación de boba — los clientes lo notan al instante. Eso incluye AirPods/audífonos — nada visible cuando estás en el piso o en el comedor.",
                    "¿Emergencia? Dile al líder. Lo resolvemos. Emergencia familiar, niño enfermo, cuidado de niños cancelado — no somos insensibles, solo necesitamos saber.",
                    "Avisar Falta. Si no puedes hacer un turno, llama a tu gerente apenas lo sepas — no 10 minutos antes de marcar entrada — y trata de conseguir tu propio reemplazo (el cambio igual necesita aprobación del gerente). Manda mensaje Y llama — un mensaje solo no cuenta hasta que alguien lo confirme. Mientras antes llames, más fácil es cubrirte. Un no-call/no-show es de las pocas cosas por las que te despiden rápido en DD Mau.",
                    "Tardanza. Tarde es tarde. Si tu turno empieza a las 11:00, esperamos verte en el piso y listo a las 11:00 — no entrando a empezar a cambiarte. No hay periodo de gracia gratuito.",
                    "Si sabes que vas a llegar tarde, manda mensaje o llama al líder en el momento que lo sepas — en el carro, en la puerta, lo que sea. Más temprano siempre es mejor; nos permite mover posiciones para cubrirte. Avisar no te justifica de llegar tarde, pero 'tarde + avisado' es mucho mejor que 'tarde + sin aviso.' Llegar muy tarde sin avisar se trata como un no-call/no-show.",
                    "Cómo se registra la tardanza — ventana móvil de 60 días:",
                    "• 1ra tardanza = nota en tu archivo, sin advertencia formal.",
                    "• 2da tardanza dentro de 60 días = advertencia escrita. La firmas.",
                    "• 3ra tardanza dentro de 60 días = advertencia final escrita + reunión con el Gerente General.",
                    "• 4ta tardanza dentro de 60 días = terminación.",
                    "Límites duros, sin importar el conteo de strikes:",
                    "• 30+ minutos tarde sin avisar antes = advertencia escrita automática.",
                    "• 3 tardanzas en cualquier ventana de 30 días = advertencia escrita automática + reunión con el Gerente General. Capturamos el patrón de 'siempre 5 minutos tarde' temprano.",
                    "Este sistema de strikes es cómo se aplica día a día la regla de tardanza del manual. Llegar tarde de forma repetida o excesiva sigue siendo causa de despido — los strikes solo hacen el camino predecible.",
                    "Por qué lo hacemos así: un mal tráfico no debería terminar tu trabajo. Pero un patrón de llegar tarde le roba al resto del equipo — ellos cubren tu estación, se quedan más tarde. El sistema de strikes te da oportunidad real de corregir después del primer fallo.",
                    "Pago. Los periodos de pago son cada dos semanas. El depósito directo cae el viernes. Si tu cheque está mal — horas mal, propinas faltantes, lo que sea — habla con tu Gerente General PRIMERO. No esperes. Los arreglos de nómina son más rápidos dentro del mismo periodo de pago.",
                    "Pool de Propinas. Las propinas se juntan y se dividen 50% Front of House / 50% Back of House. ¿Por qué 50/50? Porque la mayoría de nuestras propinas vienen de pedidos para llevar ordenados en línea — esos pedidos alimentan a ambos lados por igual, así que se dividen igual. Dentro de cada lado, las propinas se distribuyen por horas trabajadas durante el periodo. Los dueños nunca participan en el fondo de propinas."
                ]
            }
        ],
        quiz: {
            passThreshold: 0.8,
            questions: [
                {
                    id: "m2-q1",
                    questionEn: "When should you clock in for your shift?",
                    questionEs: "¿Cuándo debes marcar entrada en tu turno?",
                    options: [
                        {
                            id: "a",
                            textEn: "When you arrive at the building, before changing",
                            textEs: "Cuando llegas al edificio, antes de cambiarte"
                        },
                        {
                            id: "b",
                            textEn: "After you're in uniform and ready to work the floor",
                            textEs: "Después de estar en uniforme y listo para el piso"
                        },
                        {
                            id: "c",
                            textEn: "Whenever you remember",
                            textEs: "Cuando te acuerdes"
                        },
                        {
                            id: "d",
                            textEn: "Only after the Shift Lead clocks in",
                            textEs: "Solo después de que el líder marca entrada"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m2-q2",
                    questionEn: "How is the tip pool split at DD Mau?",
                    questionEs: "¿Cómo se divide el pool de propinas en DD Mau?",
                    options: [
                        {
                            id: "a",
                            textEn: "100% FOH",
                            textEs: "100% FOH"
                        },
                        {
                            id: "b",
                            textEn: "70% FOH / 30% BOH",
                            textEs: "70% FOH / 30% BOH"
                        },
                        {
                            id: "c",
                            textEn: "50% FOH / 50% BOH",
                            textEs: "50% FOH / 50% BOH"
                        },
                        {
                            id: "d",
                            textEn: "Tips are individual, not pooled",
                            textEs: "Las propinas son individuales, no en pool"
                        }
                    ],
                    correct: "c"
                },
                {
                    id: "m2-q3",
                    questionEn: "Where do phones stay during your shift?",
                    questionEs: "¿Dónde se quedan los teléfonos durante tu turno?",
                    options: [
                        {
                            id: "a",
                            textEn: "In your pocket — they're fine if guests don't see",
                            textEs: "En el bolsillo — está bien si los clientes no ven"
                        },
                        {
                            id: "b",
                            textEn: "At the register so you can check the time",
                            textEs: "En la caja para ver la hora"
                        },
                        {
                            id: "c",
                            textEn: "In the back. Period.",
                            textEs: "En la parte de atrás. Punto."
                        },
                        {
                            id: "d",
                            textEn: "At the boba station for the timer",
                            textEs: "En la estación de boba para el timer"
                        }
                    ],
                    correct: "c"
                },
                {
                    id: "m2-q4",
                    questionEn: "If you can't make a shift, when should you tell your manager?",
                    questionEs: "Si no puedes hacer un turno, ¿cuándo debes avisar a tu gerente?",
                    options: [
                        {
                            id: "a",
                            textEn: "10 minutes before the shift starts",
                            textEs: "10 minutos antes del turno"
                        },
                        {
                            id: "b",
                            textEn: "When you arrive late",
                            textEs: "Cuando llegues tarde"
                        },
                        {
                            id: "c",
                            textEn: "As soon as you know — earlier is always better",
                            textEs: "Apenas lo sepas — más temprano siempre es mejor"
                        },
                        {
                            id: "d",
                            textEn: "After the shift ends",
                            textEs: "Después que termine el turno"
                        }
                    ],
                    correct: "c"
                },
                {
                    id: "m2-q5",
                    questionEn: "Which is NOT acceptable footwear for the floor?",
                    questionEs: "¿Cuál NO es calzado aceptable para el piso?",
                    options: [
                        {
                            id: "a",
                            textEn: "Non-slip closed-toe sneakers",
                            textEs: "Tenis cerrados antideslizantes"
                        },
                        {
                            id: "b",
                            textEn: "Crocs (closed-toe, slip-resistant)",
                            textEs: "Crocs (cerrados, antideslizantes)"
                        },
                        {
                            id: "c",
                            textEn: "Open-toe sandals",
                            textEs: "Sandalias abiertas"
                        },
                        {
                            id: "d",
                            textEn: "Black slip-resistant work shoes",
                            textEs: "Zapatos negros antideslizantes"
                        }
                    ],
                    correct: "c"
                }
            ]
        }
    },
    {
        id: "m3",
        code: "M3",
        track: "new-hire",
        tier: "all",
        icon: "🧼",
        durationMin: 15,
        titleEn: "Food Safety Basics",
        titleEs: "Bases de Seguridad Alimentaria",
        lessons: [
            {
                id: "m3-l1",
                titleEn: "Handwashing",
                titleEs: "Lavado de Manos",
                contentEn: [
                    "Wash your hands for at least 20 seconds with hot water and soap. Twenty seconds is roughly 'Happy Birthday' twice. Less than that is performance, not hygiene.",
                    "When you must wash your hands:",
                    "• When you arrive at work — first thing, before you touch anything else (before food, equipment, the register, or the line).",
                    "• After every break.",
                    "• After eating, drinking, or using your phone.",
                    "• After using the restroom (always — no exceptions).",
                    "• After touching your face, hair, or uniform.",
                    "• After handling raw meat, raw chicken, raw fish, or raw eggs.",
                    "• After handling trash, dirty dishes, or cleaning chemicals.",
                    "• Between switching tasks (changing stations, switching ingredients).",
                    "• Before you start any food-prep task, and after handling peanuts, peanut sauce, or sesame products.",
                    "Hand sanitizer is NOT a substitute for handwashing. Sanitizer is for between-wash convenience after you've already done a real wash."
                ],
                contentEs: [
                    "Lávate las manos al menos 20 segundos con agua caliente y jabón. Veinte segundos es aproximadamente 'Feliz Cumpleaños' dos veces. Menos que eso es puro teatro, no higiene.",
                    "Cuándo lavarte las manos:",
                    "• Cuando llegues al trabajo — lo primero, antes de tocar cualquier otra cosa (comida, equipo, la caja o la línea).",
                    "• Después de cada descanso.",
                    "• Después de comer, beber o usar el teléfono.",
                    "• Después de usar el baño (siempre — sin excepciones).",
                    "• Después de tocar tu cara, cabello o uniforme.",
                    "• Después de manejar carne cruda, pollo crudo, pescado crudo o huevos crudos.",
                    "• Después de manejar basura, platos sucios o químicos.",
                    "• Entre cambios de tarea (cambiar de estación, cambiar de ingrediente).",
                    "• Antes de empezar cualquier tarea de prep, y después de manejar cacahuates, salsa de cacahuate o productos de ajonjolí.",
                    "El gel antibacterial NO sustituye el lavado de manos. El gel es para conveniencia entre lavados después de haber hecho un lavado real."
                ]
            },
            {
                id: "m3-l2",
                titleEn: "Glove Rules",
                titleEs: "Reglas de Guantes",
                contentEn: [
                    "Wash hands BEFORE putting gloves on. Gloves are not a shortcut around handwashing — bacteria from your hands transfers right through the inside of the glove and back onto the food when the glove tears.",
                    "Change gloves between raw and cooked food. Always.",
                    "Change gloves between proteins. Chicken to shrimp = new gloves. Pork to beef = new gloves. Shrimp is a shellfish allergen — the residue on your gloves is enough to send an allergic guest to the hospital.",
                    "Change gloves whenever they tear or get dirty.",
                    "Change gloves after touching your face, hair, or phone.",
                    "Never reuse gloves. Toss and grab a new pair. Gloves cost pennies; a foodborne-illness lawsuit costs hundreds of thousands.",
                    "Gloves don't replace good hygiene — they add a layer on top of it. If you wouldn't be comfortable handling that food bare-handed, gloves don't make it OK."
                ],
                contentEs: [
                    "Lávate las manos ANTES de ponerte guantes. Los guantes no son atajo del lavado de manos — las bacterias de tus manos pasan por dentro del guante y vuelven a la comida cuando el guante se rompe.",
                    "Cambia guantes entre comida cruda y cocida. Siempre.",
                    "Cambia guantes entre proteínas. Pollo a camarón = guantes nuevos. Cerdo a res = guantes nuevos. El camarón es alérgeno de mariscos — el residuo en tus guantes basta para mandar a un cliente alérgico al hospital.",
                    "Cambia guantes cuando se rompan o se ensucien.",
                    "Cambia guantes después de tocar tu cara, cabello o teléfono.",
                    "Nunca reutilices guantes. Tíralos y agarra un par nuevo. Cuestan centavos. Una demanda por enfermedad transmitida por alimentos cuesta cientos de miles.",
                    "Los guantes no reemplazan la buena higiene — agregan una capa encima. Si no te sentirías cómodo manejando comida con las manos, los guantes no lo hacen aceptable."
                ]
            },
            {
                id: "m3-l3",
                titleEn: "Temperatures & Sani Buckets",
                titleEs: "Temperaturas y Cubetas de Desinfectante",
                contentEn: [
                    "Cold-hold: 41°F or below. Coolers, walk-ins, prep-line low-boys. If a thermometer reads above 41°F, tell the Shift Lead immediately — we may need to pull product.",
                    "Hot-hold: 135°F or above. Pho broth, fried rice line, anything on a heat lamp. Below 135°F is the danger zone.",
                    "The Danger Zone: 41°F–135°F. Bacteria multiply fastest in this range. We never let cooked food sit in this range for more than 4 hours total.",
                    "Temp logs are filled out by the Shift Lead at open, mid-shift, and close. If you take a temp and it's in the danger zone, tell the Shift Lead immediately.",
                    "Sani buckets. Made fresh every shift. Changed every 4 hours OR sooner if the water gets cloudy. Concentration: quat sanitizer at 200–400 ppm — test with a quat strip, should turn dark blue.",
                    "One bucket per station. Towels stay IN the bucket between uses, never on the counter. A towel left on a counter dries out and grows bacteria.",
                    "Never put a sani bucket on a food prep surface, and never let it touch a cooler shelf. Keep it off the floor too — on a low shelf, a bucket stand, or the dedicated cleaning shelf, away from food and clean dishes. (Health inspectors check exactly this.)",
                    "Wiping is not sanitizing. Food-contact surfaces get 3 steps: WASH (hot soapy water) → RINSE (clean water) → SANITIZE (sani solution, then air-dry — no towel). Cutting boards are color-coded: green = produce, red = raw meat, blue = raw seafood, yellow = cooked meat, white = bread/dairy. Deep dive: the Cross Contamination Kitchen Training Guide in the Training Manuals folder."
                ],
                contentEs: [
                    "Frío: 41°F o menos. Refrigeradores, walk-ins, low-boys de la línea de prep. Si un termómetro marca más de 41°F, dile al líder inmediatamente — puede que tengamos que sacar producto.",
                    "Caliente: 135°F o más. Caldo de pho, línea de arroz frito, cualquier cosa en lámpara de calor. Bajo 135°F es zona de peligro.",
                    "Zona de Peligro: 41°F–135°F. Las bacterias se multiplican más rápido en este rango. Nunca dejamos comida cocida en este rango más de 4 horas en total.",
                    "Los registros de temperatura los llena el líder al abrir, a mitad del turno y al cerrar. Si tomas una temperatura y está en zona de peligro, dile al líder inmediatamente.",
                    "Cubetas de Desinfectante. Se hacen nuevas cada turno. Se cambian cada 4 horas O antes si el agua se ve turbia. Concentración: desinfectante quat a 200–400 ppm — prueba con tira quat, debe ponerse azul oscuro.",
                    "Una cubeta por estación. Los trapos se quedan DENTRO de la cubeta entre usos, nunca en el mostrador. Un trapo en el mostrador se seca y le crecen bacterias.",
                    "Nunca pongas una cubeta de desinfectante en una superficie de prep, y nunca dejes que toque un estante del cooler. Tampoco la dejes en el piso — va en un estante bajo, una base para cubetas o el estante dedicado a limpieza, lejos de comida y trastes limpios. (El inspector de salud revisa exactamente esto.)",
                    "Limpiar no es desinfectar. Las superficies que tocan comida llevan 3 pasos: LAVAR (agua caliente con jabón) → ENJUAGAR (agua limpia) → DESINFECTAR (solución sanitizante y secar al aire — sin trapo). Las tablas de cortar van por color: verde = verduras, rojo = carne cruda, azul = mariscos crudos, amarillo = carne cocida, blanco = pan/lácteos. Para más detalle: la Guía de Contaminación Cruzada en la carpeta de Manuales."
                ]
            },
            {
                id: "m3-l4",
                titleEn: "Allergens, Sickness, Cuts & Burns",
                titleEs: "Alérgenos, Enfermedad, Cortes y Quemaduras",
                contentEn: [
                    "Big 9 Allergens — every staff member needs to know these: Milk, Eggs, Fish, Shellfish, Tree Nuts, Peanuts, Wheat, Soy, Sesame.",
                    "If a guest mentions ANY of these, take it seriously. Stop. Don't guess — get the Shift Lead every time, even if you think you know the answer. They check the Allergen Matrix and confirm what's safe. The full Allergen Matrix is in M17.",
                    "When YOU are sick — stay home and call the Shift Lead. Do not work if you have: vomiting or diarrhea (in the last 24 hours), a fever, a sore throat with fever, jaundice (yellow skin or eyes), or an infected cut or wound on your hand. We would rather be short-staffed for one shift than send a foodborne illness home with our guests.",
                    "Cut on your hand. Stop. Wash. Bandage with a blue food-safety bandage (we keep them by the first-aid kit — blue so it shows up if it falls into food). Put on a glove over the bandage. Tell the Shift Lead.",
                    "Burn. Run cool water over it for at least 10 minutes. Tell the Shift Lead. Do NOT apply ice — ice can damage the burned skin further.",
                    "Anything more serious — bleeding that won't stop, a deep cut, a head injury — stop work, get the Shift Lead, and fill out an injury report. Don't 'tough it out'."
                ],
                contentEs: [
                    "Los 9 Grandes alérgenos — todo el equipo debe conocerlos: Leche, Huevos, Pescado, Mariscos, Frutos Secos, Cacahuates, Trigo, Soya, Ajonjolí.",
                    "Si un cliente menciona CUALQUIERA de estos, tómalo en serio. Para. No adivines — llama al líder siempre, aunque creas saber la respuesta. El líder revisa la Matriz de Alérgenos y confirma qué es seguro. La Matriz de Alérgenos completa está en M17.",
                    "Cuando TÚ estés enfermo — quédate en casa y llama al líder. No trabajes si tienes: vómito o diarrea (en las últimas 24 horas), fiebre, dolor de garganta con fiebre, ictericia (piel u ojos amarillos), o una cortada o herida infectada en la mano. Preferimos estar cortos de personal un turno que mandar una enfermedad transmitida por alimentos a la casa de nuestros clientes.",
                    "Corte en la mano. Para. Lava. Venda con una bandita azul de seguridad alimentaria (las tenemos junto al botiquín — azul para que se vea si cae en la comida). Pon un guante sobre la bandita. Dile al líder.",
                    "Quemadura. Ponla bajo agua fresca corriendo por lo menos 10 minutos. Dile al líder. NO apliques hielo — el hielo puede dañar más la piel quemada.",
                    "Algo más serio — sangrado que no para, corte profundo, golpe en la cabeza — para de trabajar, llama al líder, llena un reporte de lesión. No 'aguantes'."
                ]
            }
        ],
        quiz: {
            passThreshold: 0.8,
            questions: [
                {
                    id: "m3-q1",
                    questionEn: "How long should you wash your hands?",
                    questionEs: "¿Por cuánto tiempo debes lavarte las manos?",
                    options: [
                        {
                            id: "a",
                            textEn: "5 seconds with cold water",
                            textEs: "5 segundos con agua fría"
                        },
                        {
                            id: "b",
                            textEn: "At least 20 seconds with hot water and soap",
                            textEs: "Al menos 20 segundos con agua caliente y jabón"
                        },
                        {
                            id: "c",
                            textEn: "Hand sanitizer is enough",
                            textEs: "El gel antibacterial es suficiente"
                        },
                        {
                            id: "d",
                            textEn: "Just rinse — gloves do the rest",
                            textEs: "Solo enjuaga — los guantes hacen el resto"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m3-q2",
                    questionEn: "Cold-hold temperature for refrigerators is:",
                    questionEs: "La temperatura de refrigeración es:",
                    options: [
                        {
                            id: "a",
                            textEn: "Below 50°F",
                            textEs: "Bajo 50°F"
                        },
                        {
                            id: "b",
                            textEn: "41°F or below",
                            textEs: "41°F o menos"
                        },
                        {
                            id: "c",
                            textEn: "Below 32°F",
                            textEs: "Bajo 32°F"
                        },
                        {
                            id: "d",
                            textEn: "Whatever the cooler is set to",
                            textEs: "Lo que sea que marque el cooler"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m3-q3",
                    questionEn: "When must you change gloves?",
                    questionEs: "¿Cuándo debes cambiar los guantes?",
                    options: [
                        {
                            id: "a",
                            textEn: "Only when they tear",
                            textEs: "Solo cuando se rompan"
                        },
                        {
                            id: "b",
                            textEn: "Once per shift",
                            textEs: "Una vez por turno"
                        },
                        {
                            id: "c",
                            textEn: "Between raw and cooked food, between proteins, when torn or dirty, after touching face/hair/phone",
                            textEs: "Entre comida cruda y cocida, entre proteínas, al romperse o ensuciarse, después de tocar cara/cabello/teléfono"
                        },
                        {
                            id: "d",
                            textEn: "Only at the start of the shift",
                            textEs: "Solo al inicio del turno"
                        }
                    ],
                    correct: "c"
                },
                {
                    // 2026-06-20 (QA audit T4) — 5th question so M3's 80% threshold
                    // allows one miss (4 questions made 80% mean 100%). Tests a
                    // basic the lessons cover (handwashing triggers).
                    id: "m3-q4",
                    questionEn: "When should you wash your hands?",
                    questionEs: "¿Cuándo debes lavarte las manos?",
                    options: [
                        {
                            id: "a",
                            textEn: "Only at the start of your shift",
                            textEs: "Solo al inicio de tu turno"
                        },
                        {
                            id: "b",
                            textEn: "Only when they look dirty",
                            textEs: "Solo cuando se ven sucias"
                        },
                        {
                            id: "c",
                            textEn: "After the restroom, touching your face/hair/phone, handling raw meat or trash — and before handling food",
                            textEs: "Después del baño, de tocarte la cara/cabello/teléfono, de manejar carne cruda o basura — y antes de manejar comida"
                        },
                        {
                            id: "d",
                            textEn: "Only before going home",
                            textEs: "Solo antes de irte a casa"
                        }
                    ],
                    correct: "c"
                },
                {
                    id: "m3-q5",
                    questionEn: "What do you do for a cut on your hand?",
                    questionEs: "¿Qué haces si te cortas la mano?",
                    options: [
                        {
                            id: "a",
                            textEn: "Keep working — it's small",
                            textEs: "Sigue trabajando — es chico"
                        },
                        {
                            id: "b",
                            textEn: "Wash, blue food-safety bandage, glove over it, tell the Shift Lead",
                            textEs: "Lavar, bandita azul de seguridad alimentaria, guante encima, avisar al líder"
                        },
                        {
                            id: "c",
                            textEn: "Wrap in a paper towel",
                            textEs: "Envolver en una toalla de papel"
                        },
                        {
                            id: "d",
                            textEn: "Use any color bandage",
                            textEs: "Usar bandita de cualquier color"
                        }
                    ],
                    correct: "b"
                }
            ]
        }
    },
    {
        id: "m6",
        code: "M6",
        track: "stations",
        tier: "all",
        icon: "💵",
        durationMin: 20,
        titleEn: "Position: Cashier",
        titleEs: "Estación: Cajero",
        lessons: [
            {
                id: "m6-l1",
                titleEn: "What Register Owns + Opening Setup",
                titleEs: "Lo Que Le Toca a la Caja + Inicio de Turno",
                contentEn: [
                    "You are the face of DD Mau. Every guest's first impression starts with you. Your job: greet them, take their order on Toast, ring them up, answer menu questions, and set the energy for their visit. The 10-Second Rule starts with you.",
                    "OPENING SETUP — first 30 minutes of your shift:",
                    "• Wash hands, then clock in.",
                    "• Log into Toast with your PIN. Confirm the printer at the kitchen line is printing.",
                    "• Wipe down the register, card reader, phone, counter, and laminated menus. Make sure the area is organized and the table numbers are stacked and ready to go.",
                    "• Stock 1oz sauce cups, lids, napkins, utensils, and to-go bags within reach.",
                    "• Stock extra bowls, plates, and to-go utensils.",
                    "• Stock the soda fridge so every drink has 2 rows facing forward.",
                    "• Take note of any out-of-stock items and check with the Shift Lead that they're still out.",
                    "• Smile. Take a deep breath. Ready up."
                ],
                contentEs: [
                    "Eres la cara de DD Mau. La primera impresión de cada cliente empieza contigo. Tu trabajo: saludarlos, tomar su orden en Toast, cobrarles, contestar preguntas del menú, y poner la energía de su visita. La Regla de los 10 Segundos empieza contigo.",
                    "INICIO DE TURNO — primeros 30 minutos:",
                    "• Lávate las manos y luego marca entrada.",
                    "• Entra a Toast con tu PIN. Confirma que la impresora de la línea de cocina está imprimiendo.",
                    "• Limpia la registradora, el lector de tarjetas, el teléfono, el mostrador y los menús laminados. Asegúrate de que el área esté organizada y los números de mesa estén apilados y listos.",
                    "• Surte vasos de salsa de 1oz, tapas, servilletas, utensilios y bolsas para llevar al alcance.",
                    "• Surte bowls extra, platos y utensilios para llevar.",
                    "• Surte el refrigerador de sodas — cada bebida con 2 filas al frente.",
                    "• Toma nota de los artículos agotados y confirma con el líder que siguen agotados.",
                    "• Sonríe. Respira. Listo."
                ]
            },
            {
                id: "m6-l2",
                titleEn: "During Service — Greet, Ring, Read Back",
                titleEs: "Durante el Servicio — Saluda, Cobra, Repite",
                contentEn: [
                    "Acknowledge every guest within 10 seconds — eye contact, smile, 'Welcome to DD Mau!' This is non-negotiable. Even if you can't take their order yet, they need to know you saw them.",
                    "Use the Bright 4 (M1 L4 has the full breakdown): Eyes Up, Light Up, Speak Up, Show Up.",
                    "Ring every order into Toast with full accuracy: protein, sauce, modifiers, allergy notes.",
                    "ALWAYS ask 'any allergies I should know about?' — every order, every time. Even if the guest seems annoyed, you ask. If the answer is YES: stop, tap the Allergy modifier in Toast, and get the Shift Lead — they confirm what is safe using the M17 Allergen Matrix. Never guess and never answer an allergy question on your own.",
                    "BOBA MILK TEA DISCLOSURE — anytime a guest orders any boba milk tea, say this verbatim: \"Just so you know, our boba milk teas use a milk-powder base that already has a non-dairy creamer mixed in — we can't take the creamer out, and the creamer is made from a milk derivative. So if you have a milk allergy, please don't order one. Our fruit teas are completely safe — they never touch the milk powder.\" This is non-negotiable. The 'Non-Dairy Creamer' bag lists sodium caseinate and lactose — both milk derivatives. A milk-allergic guest can have a serious reaction. We tell every guest, every time. If they say they're lactose-intolerant (digestion only, not an allergy), the milk teas are usually fine for them. IF THEY SAY ALLERGY — redirect to a FRUIT TEA. That is the only safe option. Subbing oat, soy, or almond milk does NOT fix a boba milk tea — the allergen is already in the powder base, so 'just sub oat milk in my milk tea' is NOT a workaround. For a milk allergy the answer is a fruit tea, period. (Separate fact to remember: almond milk is a tree-nut allergen.)",
                    "\"NO MILK\" REQUEST ON A MILK TEA — a guest will sometimes order a milk tea and say \"no milk.\" They think \"no milk\" makes it dairy-free. It doesn't — there's no separate milk to leave out; the creamer is already in the base. Say this verbatim: \"We don't add any milk to your drink — but just so you know, the creamer in our boba milk tea base is labeled non-dairy, yet it's made from a milk derivative. So if you have a milk allergy, please don't order one. Our fruit teas are completely safe.\" Same rule applies: if they confirm an allergy, redirect to a fruit tea. Never assume \"no milk\" = safe.",
                    "If the guest has an allergy, tap the Allergy modifier in Toast — that flags the ticket in red for the kitchen.",
                    "Use the modifier buttons in Toast for protein, sauce, extras, and removals. NEVER type modifications as free text — the kitchen will not see free-text notes.",
                    "Read the order back before you cash them out. 'Pho with brisket, two egg rolls, and a Thai tea — sound right?' This catches more mistakes than any other single habit.",
                    "Hand the guest a number tent and tell them where to find condiments and silverware.",
                    "Call out 'behind!' or 'corner!' when moving with hot drinks or trays."
                ],
                contentEs: [
                    "Reconoce a cada cliente en 10 segundos — contacto visual, sonrisa, '¡Bienvenido a DD Mau!' No es negociable. Aunque no puedas tomarle la orden todavía, necesita saber que lo viste.",
                    "Usa los Bright 4 (M1 L4 tiene el desglose completo): Ojos Arriba, Cara Iluminada, Habla Alto, Aparece.",
                    "Cobra cada orden en Toast con exactitud completa: proteína, salsa, modificadores, notas de alergia.",
                    "SIEMPRE pregunta '¿alguna alergia que deba saber?' — cada orden, cada vez. Aunque el cliente se moleste, preguntas. Si la respuesta es SÍ: para, toca el modificador de Allergy en Toast y llama al líder — él confirma qué es seguro usando la Matriz de Alérgenos M17. Nunca adivines ni contestes una pregunta de alergias por tu cuenta.",
                    "AVISO DE BOBA MILK TEA — cada vez que un cliente pida cualquier boba milk tea, di esto al pie de la letra: \"Para que sepa, nuestros boba milk teas usan una base de leche en polvo que ya tiene la crema non-dairy mezclada — no podemos quitar la crema, y la crema está hecha de un derivado lácteo. Así que si tiene alergia a la leche, por favor no lo ordene. Nuestros fruit teas son completamente seguros — nunca tocan la leche en polvo.\" No es negociable. La bolsa dice 'Non-Dairy Creamer,' pero los ingredientes incluyen caseinato de sodio y lactosa — ambos derivados lácteos. Un cliente alérgico a la leche puede tener una reacción grave. Le decimos a cada cliente, cada vez. Si dice que es intolerante a la lactosa (solo digestión, no alergia), los milk teas usualmente están bien. SI DICE ALERGIA — redirígelo a un FRUIT TEA. Esa es la única opción segura. Cambiar a leche de avena, soya o almendra NO arregla un boba milk tea — el alérgeno ya está en la base en polvo, así que 'cámbiame a leche de avena en mi milk tea' NO es solución. Para alergia a la leche, la respuesta es un fruit tea, punto. (Dato aparte para recordar: la leche de almendra es alérgeno de fruto seco.)",
                    "PEDIDO DE \"SIN LECHE\" EN UN MILK TEA — a veces un cliente pide un milk tea y dice \"sin leche.\" Cree que \"sin leche\" lo hace libre de lácteos. No es así — no hay una leche aparte que omitir; la crema YA está en la base. Di esto al pie de la letra: \"No le agregamos leche a su bebida — pero para que sepa, la crema de la base de nuestros boba milk teas está etiquetada non-dairy, pero está hecha de un derivado lácteo. Así que si tiene alergia a la leche, por favor no lo ordene. Nuestros fruit teas son completamente seguros.\" Misma regla: si confirma alergia, redirígelo a un fruit tea. Nunca asumas que \"sin leche\" = seguro.",
                    "Si el cliente tiene alergia, toca el modificador de Allergy en Toast — eso marca el ticket en rojo para la cocina.",
                    "Usa los botones de modificador en Toast para proteína, salsa, extras y omisiones. NUNCA escribas modificaciones como texto libre — la cocina no ve las notas de texto libre.",
                    "Repite la orden antes de cobrar. 'Pho con pecho, dos rollos primavera y un té tailandés — ¿correcto?' Esto atrapa más errores que cualquier otro hábito.",
                    "Dale al cliente un número de mesa y dile dónde encontrar condimentos y cubiertos.",
                    "Grita '¡detrás!' o '¡esquina!' cuando te muevas con bebidas calientes o bandejas."
                ]
            },
            {
                id: "m6-l3",
                titleEn: "Handoffs, Restocks, and Cash Rules",
                titleEs: "Entregas, Reabastecimiento y Reglas de Efectivo",
                contentEn: [
                    "Voids, refunds, and comps go to the Shift Lead (or manager). Always. Only Shift Leads and managers have Toast permission for these. If a guest asks for a refund or comp, smile and say 'let me grab the Shift Lead for you.' Never process it yourself.",
                    "Why: tracking voids is for accountability, not blame. Going through the Shift Lead keeps the cash drawer clean and protects you.",
                    "Card payments: never take a card out of a guest's hand. Direct them to insert/tap the reader themselves. (PCI security rule.)",
                    "Cash payment: enter the tendered amount in Toast, count the change in front of the guest, and hand it back. Only print a receipt if the guest selected 'print receipt' in Toast — otherwise no paper receipt.",
                    "Restock between rushes — don't wait until you run out. Cups, lids, sauces, napkins, to-go bags. If we run out of forks mid-rush, the line stops — restocking is your job.",
                    "Re-check the 86'd list (in Toast, or the 86 board in the DD Mau app) whenever the Shift Lead updates it. If you're not sure whether something's still 86'd, check before you ring it.",
                    "LAST CALL — the kitchen closes at 7:45 PM. Anyone already in line or at the counter at 7:45 (or a couple of minutes after) gets served — full menu, full energy. Anyone who walks in after 7:45: catch them at the door before they line up, warmly: 'I'm really sorry — our kitchen just closed for the night. We'd love to see you tomorrow — we open at 11!' Drinks or grab-and-go desserts after 7:45: check with the Shift Lead or manager first — don't ring them on your own. If a guest pushes back or gets upset, stay calm and get the Shift Lead or manager. (Full scripts: the Last Call Guide.)",
                    "Phone Policy at the register: phone stays in the back. No exceptions. Guests notice immediately.",
                    "No eating or gum chewing at the register. Drinks stay out of sight — under the counter, in the back, never on top where guests can see.",
                    "If the line is long, ring faster — be friendly AND fast. Don't stop ringing to chat. The next guest in line is also a guest.",
                    "Pausing orders (very rare): if you can see the kitchen is badly backed up, slow your ringing and flag the Shift Lead or manager. If they tell you to pause ordering, tell the guests in line: 'We have to pause orders for 5 minutes to let the kitchen catch up — sorry for the wait, we'll be right with you.' Stay calm and friendly — protecting food quality is why we do this."
                ],
                contentEs: [
                    "Voids, reembolsos y comps van al líder de turno (o al gerente). Siempre. Solo los líderes y gerentes tienen permiso en Toast para esto. Si un cliente pide un reembolso o comp, sonríe y dile 'déjame llamar al líder.' Nunca lo proceses tú.",
                    "Por qué: rastrear voids es por responsabilidad, no por culpa. Ir a través del líder mantiene la caja limpia y te protege.",
                    "Pagos con tarjeta: nunca tomes la tarjeta de la mano del cliente. Indícale que la inserte/toque él mismo. (Regla de seguridad PCI.)",
                    "Pago en efectivo: ingresa la cantidad recibida en Toast, cuenta el cambio enfrente del cliente, y entrégaselo. Solo imprime recibo si el cliente eligió 'print receipt' en Toast — si no, sin recibo de papel.",
                    "Reabastece entre los rushes — no esperes a que se acabe. Vasos, tapas, salsas, servilletas, bolsas. Si nos quedamos sin tenedores en pleno rush, la fila se detiene — surtir es tu trabajo.",
                    "Vuelve a revisar la lista de 86 (en Toast o en el tablero de 86 de la app de DD Mau) cuando el líder la actualice. Si no estás seguro si algo sigue en 86, revisa antes de cobrar.",
                    "ÚLTIMA LLAMADA — la cocina cierra a las 7:45 PM. Quien ya esté en la fila o en el mostrador a las 7:45 (o un par de minutos después) se atiende — menú completo, misma energía. Quien entre después de las 7:45: recíbelo en la puerta antes de que se forme, con calidez: 'Lo siento mucho — la cocina acaba de cerrar por hoy. ¡Nos encantaría verlo mañana — abrimos a las 11!' Bebidas o postres listos después de las 7:45: confirma primero con el líder o el gerente — no los cobres por tu cuenta. Si el cliente insiste o se molesta, mantén la calma y llama al líder o al gerente. (Guiones completos: la Guía de Last Call.)",
                    "Política de teléfonos en la caja: el teléfono se queda atrás. Sin excepciones. Los clientes notan al instante.",
                    "Sin comer ni mascar chicle en la caja. Las bebidas se quedan fuera de la vista — debajo del mostrador, en la parte de atrás, nunca arriba donde los clientes puedan verlas.",
                    "Si la fila está larga, cobra más rápido — sé amable Y rápido. No pares de cobrar para platicar. El siguiente en la fila también es cliente.",
                    "Pausar órdenes (muy raro): si ves que la cocina está muy saturada, cobra más despacio y avísale al líder o al gerente. Si te dicen que pauses las órdenes, dile a los clientes en la fila: 'Tenemos que pausar las órdenes por 5 minutos para que la cocina se ponga al día — disculpen la espera, ya estamos con ustedes.' Mantente calmado y amable — lo hacemos para proteger la calidad de la comida."
                ]
            },
            {
                id: "m6-l4",
                titleEn: "Closing & Common Mistakes",
                titleEs: "Cierre y Errores Comunes",
                contentEn: [
                    "CLOSING — the wall checklist at each location (3-person and 4-person versions) is the source of truth; who closes what is posted on the board. This list is a quick reference.",
                    "• Organize the number tents.",
                    "• Wipe down the register, card reader, and phones.",
                    "• Check sodas and restock the fridge so it looks presentable.",
                    "• Take out cakes if needed for next day per par: 9 VC, 6 VL, 6 TL, 6 VT (ask the Shift Lead which cake each code stands for).",
                    "• Wipe down the trash can, take trash to the back per Shift Lead direction.",
                    "• Wipe tables, put up chairs, sweep behind the POS.",
                    "• At 8pm: turn off TVs, fridge interior lights, music. (The open sign is automatic — no action needed.)",
                    "COMMON MISTAKES — skip the painful learning curve:",
                    "• Looking down at the register when a guest walks in. Always Eyes Up.",
                    "• Forgetting to ask about allergies. Non-negotiable.",
                    "• Punching modifications free-form into Toast instead of using the modifier buttons. The kitchen does not see typed notes — use the modifier button whenever one exists.",
                    "• Processing a void or refund yourself. Never — Shift Lead only.",
                    "• Letting the line back up because you stopped ringing to chat.",
                    "• Eating, drinking, or chewing gum at the register."
                ],
                contentEs: [
                    "CIERRE — el checklist de la pared de cada local (versión de 3 o 4 personas) es la fuente verdadera; quién cierra qué se publica en el pizarrón. Esta lista es referencia rápida.",
                    "• Organiza los números de mesa.",
                    "• Limpia la registradora, el lector de tarjetas y los teléfonos.",
                    "• Revisa sodas y surte el refrigerador para que se vea presentable.",
                    "• Saca los pasteles para el día siguiente según el par: 9 VC, 6 VL, 6 TL, 6 VT (pregúntale al líder qué pastel es cada código).",
                    "• Limpia el bote de basura, lleva la basura atrás según el líder.",
                    "• Limpia mesas, sube las sillas, barre detrás del POS.",
                    "• A las 8pm: apaga TVs, luces interiores del refrigerador, música. (El letrero abierto es automático — sin acción.)",
                    "ERRORES COMUNES — sáltate la curva dolorosa de aprendizaje:",
                    "• Mirar abajo a la registradora cuando entra un cliente. Siempre Ojos Arriba.",
                    "• Olvidar preguntar por alergias. No es negociable.",
                    "• Escribir modificaciones como texto libre en Toast en lugar de usar los botones de modificador. La cocina no ve las notas escritas — usa el botón de modificador siempre que exista.",
                    "• Procesar un void o reembolso tú solo. Nunca — solo el líder.",
                    "• Dejar que la fila se atore porque paraste de cobrar para platicar.",
                    "• Comer, beber o mascar chicle en la caja."
                ]
            }
        ],
        quiz: {
            passThreshold: 0.8,
            questions: [
                {
                    id: "m6-q1",
                    questionEn: "A guest asks for a refund. What do you do?",
                    questionEs: "Un cliente pide un reembolso. ¿Qué haces?",
                    options: [
                        {
                            id: "a",
                            textEn: "Process the refund yourself in Toast",
                            textEs: "Procesa el reembolso tú mismo en Toast"
                        },
                        {
                            id: "b",
                            textEn: "Tell the guest 'no refunds'",
                            textEs: "Dile al cliente 'sin reembolsos'"
                        },
                        {
                            id: "c",
                            textEn: "Smile and say 'let me grab the Shift Lead for you'",
                            textEs: "Sonríe y di 'déjame llamar al líder'"
                        },
                        {
                            id: "d",
                            textEn: "Call the General Manager directly on their cell",
                            textEs: "Llama al Gerente General directamente al celular"
                        }
                    ],
                    correct: "c"
                },
                {
                    id: "m6-q2",
                    questionEn: "When ringing an order in Toast, how do you handle modifications like 'no peanuts' or 'sub vegan beef'?",
                    questionEs: "Al cobrar una orden en Toast, ¿cómo manejas modificaciones como 'sin cacahuates' o 'cambia a carne vegana'?",
                    options: [
                        {
                            id: "a",
                            textEn: "Type a free-text note for the kitchen",
                            textEs: "Escribe una nota de texto libre para la cocina"
                        },
                        {
                            id: "b",
                            textEn: "Tap the modifier buttons — never free-text",
                            textEs: "Toca los botones de modificador — nunca texto libre"
                        },
                        {
                            id: "c",
                            textEn: "Tell the guest verbally and trust the kitchen will figure it out",
                            textEs: "Dile verbalmente al cliente y confía en que la cocina lo entenderá"
                        },
                        {
                            id: "d",
                            textEn: "Skip Toast and walk back to the kitchen to tell the cook",
                            textEs: "Sáltate Toast y ve a la cocina a decirle al cocinero"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m6-q5",
                    questionEn: "When must you ask about allergies?",
                    questionEs: "¿Cuándo debes preguntar por alergias?",
                    options: [
                        {
                            id: "a",
                            textEn: "Only if the guest looks like they might have an allergy",
                            textEs: "Solo si el cliente parece tener una alergia"
                        },
                        {
                            id: "b",
                            textEn: "Only on dine-in orders, not to-go",
                            textEs: "Solo en órdenes para comer aquí, no para llevar"
                        },
                        {
                            id: "c",
                            textEn: "Every order, every time — even if the guest seems annoyed",
                            textEs: "Cada orden, cada vez — aunque el cliente se moleste"
                        },
                        {
                            id: "d",
                            textEn: "Only when ordering pho or peanut sauce",
                            textEs: "Solo al ordenar pho o salsa de cacahuate"
                        }
                    ],
                    correct: "c"
                },
                {
                    id: "m6-q6",
                    questionEn: "A guest hands you their card. What do you do?",
                    questionEs: "Un cliente te da su tarjeta. ¿Qué haces?",
                    options: [
                        {
                            id: "a",
                            textEn: "Take it and run it on the reader for them",
                            textEs: "Tómala y pásala en el lector por ellos"
                        },
                        {
                            id: "b",
                            textEn: "Politely direct them to insert or tap the reader themselves",
                            textEs: "Indícale amablemente que inserte o toque la tarjeta en el lector por su cuenta"
                        },
                        {
                            id: "c",
                            textEn: "Type the card number into Toast manually",
                            textEs: "Escribe el número de tarjeta en Toast manualmente"
                        },
                        {
                            id: "d",
                            textEn: "Take it and ask for ID",
                            textEs: "Tómala y pide identificación"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m6-q7",
                    questionEn: "A guest orders a Black Milk Tea and mentions they have a milk allergy. What do you do?",
                    questionEs: "Un cliente pide un Black Milk Tea y menciona que tiene alergia a la leche. ¿Qué haces?",
                    options: [
                        {
                            id: "a",
                            textEn: "Tell them it's safe — the bag says non-dairy creamer",
                            textEs: "Dile que es seguro — la bolsa dice non-dairy creamer"
                        },
                        {
                            id: "b",
                            textEn: "Offer to sub oat or almond milk in the milk tea",
                            textEs: "Ofrece cambiar a leche de avena o almendra en el milk tea"
                        },
                        {
                            id: "c",
                            textEn: "Tell them the creamer is already in the milk-powder base and redirect them to a fruit tea",
                            textEs: "Dile que la crema ya viene en la base de leche en polvo y redirígelo a un fruit tea"
                        },
                        {
                            id: "d",
                            textEn: "Make it with less creamer to be safe",
                            textEs: "Hazlo con menos crema para estar seguro"
                        }
                    ],
                    correct: "c"
                }
            ]
        }
    },
    {
        id: "m7",
        code: "M7",
        track: "stations",
        tier: "all",
        icon: "🛍️",
        durationMin: 15,
        titleEn: "Position: Bagger",
        titleEs: "Estación: Empaque",
        lessons: [
            {
                id: "m7-l1",
                titleEn: "What Bagging Owns + Opening Setup",
                titleEs: "Lo Que Le Toca a Empaque + Inicio de Turno",
                contentEn: [
                    "You bag every to-go order. At DD Mau every bag goes out the SAME WAY regardless of order size — same packing logic, same ticket on the bag, same hand-off. The customer who orders one banh mi gets the same care as the customer who orders for the whole office.",
                    "OPENING SETUP:",
                    "• Wash hands, then clock in.",
                    "• Wipe down the expo countertop and bagging station.",
                    "• Lay out to-go trays for the morning shift.",
                    "• Restock 1oz sauces, condiments, utensil packs, and napkins on the expo line.",
                    "• Restock pho plates and pho garnish trays.",
                    "• Make sure stickers (round dots), staplers, Sharpies, and sleeves are at the bagging station.",
                    "• Confirm the current 86'd list in Toast with the Shift Lead."
                ],
                contentEs: [
                    "Empacas cada orden para llevar. En DD Mau cada bolsa sale IGUAL, sin importar el tamaño — misma lógica de empaque, mismo ticket en la bolsa, misma entrega. El cliente que ordena un banh mi recibe el mismo cuidado que el que ordena para toda la oficina.",
                    "INICIO DE TURNO:",
                    "• Lávate las manos y luego marca entrada.",
                    "• Limpia el mostrador de expo y la estación de empaque.",
                    "• Pon las bandejas para llevar listas para el turno de la mañana.",
                    "• Surte salsas de 1oz, condimentos, paquetes de utensilios y servilletas en la línea de expo.",
                    "• Surte platos de pho y bandejas de guarnición de pho.",
                    "• Confirma que las calcomanías (dots redondos), engrapadora, Sharpies y sleeves estén en la estación de empaque.",
                    "• Confirma la lista actual de 86 en Toast con el líder."
                ]
            },
            {
                id: "m7-l2",
                titleEn: "The DD Mau Bagging Process — Same for Every Order",
                titleEs: "El Proceso de Empaque de DD Mau — Igual para Cada Orden",
                contentEn: [
                    "READ THE TICKET FIRST. Every time. Customer name, item list, modifiers, allergy notes. The ticket is the single source of truth.",
                    "BUILD THE BAG. Heavy items at the bottom (pho, fried rice), sauces and lighter items on top, drinks separate. Cold drinks NEVER go at the bottom of a hot bag. Several bowls plus a pho in the same order? Bowls go in first, then the pho on top — the pho comes on a styrofoam tray, and if that tray goes in the bag first the bowls will crush it.",
                    "STAPLE THE TICKET on the OUTSIDE of the bag. Customer name and item list visible at a glance — that's how the cashier or food runner knows whose order it is.",
                    "IF THE ORDER HAS DESSERT, write 'DESSERT IN BAG' on the ticket with the Sharpie. The handler sees the note and confirms before handing the bag over.",
                    "IF THE ORDER HAS A DRINK, YOU (the bagger) put a round sticker (dot) on the ticket. The sticker is the signal: 'this order needs a drink picked up from the Drinks station before it goes to the guest.' If you see a drink on the ticket but no sticker, add one before the bag goes to the hand-off area.",
                    "IF THE ORDER IS A CALL-IN, the ticket will have CALL IN circled. Circled = the handler must take payment when the guest arrives to pick up. If you see CALL IN on the ticket and it isn't circled, circle it.",
                    "MULTI-BAG ORDERS — large to-go or catering — write 'BAG 1 OF 2' (or 1 OF 3, etc.) on each ticket and staple matching tickets so the handler knows to grab all bags.",
                    "TRIPLE-CHECK SAUCE on every order — and make sure napkins and utensils are in every bag. Forgotten sauce is the #1 guest complaint we get.",
                    "Done? Place the bag at the hand-off area for the cashier or food runner to grab."
                ],
                contentEs: [
                    "LEE EL TICKET PRIMERO. Cada vez. Nombre del cliente, lista de artículos, modificadores, notas de alergia. El ticket es la única fuente verdadera.",
                    "ARMA LA BOLSA. Cosas pesadas al fondo (pho, arroz frito), salsas y cosas ligeras arriba, bebidas separadas. Las bebidas frías NUNCA van al fondo de una bolsa caliente. ¿Varios bowls más un pho en la misma orden? Los bowls van primero y el pho arriba — el pho va en una bandeja de unicel, y si esa bandeja va al fondo los bowls la aplastan.",
                    "ENGRAPA EL TICKET en el EXTERIOR de la bolsa. Nombre del cliente y lista de artículos visibles de un vistazo — así el cajero o food runner sabe de quién es la orden.",
                    "SI LA ORDEN TIENE POSTRE, escribe 'DESSERT IN BAG' en el ticket con el Sharpie. La persona que entrega ve la nota y confirma antes de entregar la bolsa.",
                    "SI LA ORDEN TIENE BEBIDA, TÚ (el bagger) pones una calcomanía redonda (dot) en el ticket. La calcomanía es la señal: 'esta orden necesita recoger una bebida en la estación de Drinks antes de salir al cliente.' Si ves una bebida en el ticket pero sin calcomanía, ponla antes de pasar la bolsa al área de entrega.",
                    "SI LA ORDEN ES CALL-IN, el ticket tendrá CALL IN circulado. Circulado = la persona que entrega debe cobrar cuando el cliente llega a recoger. Si ves CALL IN en el ticket y no está circulado, circúlalo.",
                    "ÓRDENES DE VARIAS BOLSAS — para llevar grandes o catering — escribe 'BAG 1 OF 2' (o 1 OF 3, etc.) en cada ticket y engrapa los tickets correspondientes para que la persona que entrega sepa agarrar todas las bolsas.",
                    "REVISA TRES VECES LA SALSA en cada orden — y asegúrate de que cada bolsa lleve servilletas y utensilios. La salsa olvidada es la queja #1 de clientes.",
                    "¿Listo? Pon la bolsa en el área de entrega para que el cajero o food runner la agarre."
                ]
            },
            {
                id: "m7-l3",
                titleEn: "Pho-to-Go + Special Items",
                titleEs: "Pho para Llevar + Artículos Especiales",
                contentEn: [
                    "PHO TO-GO has a specific bagging order:",
                    "1. Hot broth goes in a 32oz soup container with the lid pressed on tight, then sleeved, then bagged.",
                    "2. Noodles and protein in a separate container (so the noodles don't bloat in the broth on the drive home — the guest combines at home).",
                    "3. The pho garnish tray — thai basil, bean sprouts, lime — goes in a SEPARATE bag or tray so the garnishes stay cold and don't wilt next to the hot soup.",
                    "EGG ROLLS go in a paper-lined sleeve, not directly in the plastic to-go box. Plastic-on-egg-roll steams them soggy by the time the guest gets home.",
                    "BAO SLIDERS — wrap each individually in paper before bagging so they don't stick to each other.",
                    "If something on the ticket is unclear (modifier you can't read, missing protein, an allergy note that doesn't match the items), STOP and ask the Shift Lead. A 30-second pause is much cheaper than a wrong order."
                ],
                contentEs: [
                    "PHO PARA LLEVAR tiene un orden específico de empaque:",
                    "1. El caldo caliente va en un recipiente de sopa de 32oz con la tapa bien cerrada, luego con sleeve, luego en bolsa.",
                    "2. Fideos y proteína en un recipiente separado (para que los fideos no se hinchen en el caldo en el camino — el cliente los junta en casa).",
                    "3. El plato de guarnición de pho — albahaca tailandesa, germinado de soya, limón — va en una bolsa o bandeja SEPARADA para que las guarniciones queden frías y no se marchiten junto al caldo caliente.",
                    "LOS EGG ROLLS (rollos fritos) van en un sleeve forrado de papel, no directo en la caja de plástico para llevar. El plástico sobre el egg roll lo cuece al vapor y queda aguado cuando el cliente llega a casa.",
                    "BAO SLIDERS — envuelve cada uno individualmente en papel antes de empacar para que no se peguen entre sí.",
                    "Si algo en el ticket no está claro (un modificador que no puedes leer, falta proteína, una nota de alergia que no encaja con los artículos), DETENTE y pregúntale al líder. Una pausa de 30 segundos es mucho más barata que una orden equivocada."
                ]
            },
            {
                id: "m7-l4",
                titleEn: "Closing & Common Mistakes",
                titleEs: "Cierre y Errores Comunes",
                contentEn: [
                    "CLOSING — wall checklist is the source of truth.",
                    "• Restock condiments on the expo line and utensils for next shift.",
                    "• Restock 1oz sauces.",
                    "• Put away pho plates and garnish trays.",
                    "• Refill the sticker / Sharpie / stapler / sleeve kit at the bagging station.",
                    "• Clean countertops and lay out to-go trays for the morning.",
                    "• Wipe down phone and handheld.",
                    "• Sweep/mop from the expo line to the register.",
                    "• Help finish cleaning the dining room.",
                    "• Restock drinks.",
                    "COMMON MISTAKES:",
                    "• Bagging without reading the ticket.",
                    "• Forgetting sauce on a to-go order. The #1 guest complaint we get.",
                    "• Forgetting to write 'DESSERT IN BAG' on the ticket — the handler doesn't see it and doesn't add the dessert.",
                    "• Forgetting the round sticker on a drink order — the handler walks out without grabbing the drink.",
                    "• Forgetting to circle CALL IN — the handler doesn't take payment from the call-in guest.",
                    "• Forgetting to tag multi-bag orders ('1 OF 2') — the handler walks out with only one bag.",
                    "• Putting cold drinks at the bottom of a hot bag.",
                    "• Mixing up two similar tickets in a rush.",
                    "• Letting the expo line run out of utensils or sauce cups — restock between rushes, not at the end."
                ],
                contentEs: [
                    "CIERRE — el checklist de la pared es la fuente verdadera.",
                    "• Surte condimentos en la línea de expo y utensilios para el siguiente turno.",
                    "• Surte salsas de 1oz.",
                    "• Guarda los platos de pho y bandejas de guarnición.",
                    "• Surte el kit de calcomanías / Sharpie / engrapadora / sleeves en la estación de empaque.",
                    "• Limpia mostradores y deja bandejas para llevar listas para la mañana.",
                    "• Limpia teléfono y POS de mano.",
                    "• Barre/mopea de la línea de expo a la caja.",
                    "• Ayuda a terminar de limpiar el comedor.",
                    "• Surte bebidas.",
                    "ERRORES COMUNES:",
                    "• Empacar sin leer el ticket.",
                    "• Olvidar la salsa en una orden para llevar. La queja #1 de clientes.",
                    "• Olvidar escribir 'DESSERT IN BAG' en el ticket — la persona que entrega no lo ve y no agrega el postre.",
                    "• Olvidar la calcomanía redonda en una orden con bebida — la persona se va sin agarrar la bebida.",
                    "• Olvidar circular CALL IN — la persona no cobra al cliente que llamó.",
                    "• Olvidar marcar las órdenes de varias bolsas ('1 OF 2') — la persona se va con solo una bolsa.",
                    "• Poner bebidas frías al fondo de una bolsa caliente.",
                    "• Confundir dos tickets parecidos en un rush.",
                    "• Dejar que la línea de expo se quede sin utensilios o vasitos de salsa — surte entre rushes, no al final."
                ]
            }
        ],
        quiz: {
            passThreshold: 0.8,
            questions: [
                {
                    id: "m7-q1",
                    questionEn: "What's the FIRST thing you do before building a to-go bag?",
                    questionEs: "¿Qué es lo PRIMERO que haces antes de armar una bolsa para llevar?",
                    options: [
                        {
                            id: "a",
                            textEn: "Grab the bag and start filling",
                            textEs: "Agarrar la bolsa y empezar a llenar"
                        },
                        {
                            id: "b",
                            textEn: "Read the ticket — customer name, items, modifiers, allergy notes",
                            textEs: "Leer el ticket — nombre del cliente, artículos, modificadores, notas de alergia"
                        },
                        {
                            id: "c",
                            textEn: "Yell to the kitchen what's coming",
                            textEs: "Gritarle a la cocina qué viene"
                        },
                        {
                            id: "d",
                            textEn: "Ask the guest to confirm their order",
                            textEs: "Pedirle al cliente que confirme su orden"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m7-q2",
                    questionEn: "How is pho-to-go packaged?",
                    questionEs: "¿Cómo se empaca el pho para llevar?",
                    options: [
                        {
                            id: "a",
                            textEn: "Everything in one container",
                            textEs: "Todo en un recipiente"
                        },
                        {
                            id: "b",
                            textEn: "Hot broth in soup container + sleeve + bag · noodles/protein separate · garnish tray separate so it stays cold",
                            textEs: "Caldo en recipiente de sopa + sleeve + bolsa · fideos/proteína aparte · bandeja de guarnición aparte para que se mantenga fría"
                        },
                        {
                            id: "c",
                            textEn: "In a paper bowl with a lid",
                            textEs: "En un bowl de papel con tapa"
                        },
                        {
                            id: "d",
                            textEn: "Whatever fits in the to-go tray",
                            textEs: "Lo que quepa en la bandeja"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m7-q3",
                    questionEn: "What does a round sticker on the order ticket mean?",
                    questionEs: "¿Qué significa una calcomanía redonda en el ticket?",
                    options: [
                        {
                            id: "a",
                            textEn: "The order has dessert",
                            textEs: "La orden tiene postre"
                        },
                        {
                            id: "b",
                            textEn: "The order has a drink — handler must grab it from the Drinks station",
                            textEs: "La orden tiene bebida — quien entrega debe agarrarla en la estación de Drinks"
                        },
                        {
                            id: "c",
                            textEn: "The order is paid in cash",
                            textEs: "La orden está pagada en efectivo"
                        },
                        {
                            id: "d",
                            textEn: "The customer is a regular",
                            textEs: "El cliente es habitual"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m7-q4",
                    questionEn: "An order has dessert. What do you do on the ticket?",
                    questionEs: "Una orden tiene postre. ¿Qué haces en el ticket?",
                    options: [
                        {
                            id: "a",
                            textEn: "Nothing — the bag is enough",
                            textEs: "Nada — con la bolsa basta"
                        },
                        {
                            id: "b",
                            textEn: "Write 'DESSERT IN BAG' with the Sharpie so the handler sees it",
                            textEs: "Escribe 'DESSERT IN BAG' con el Sharpie para que la persona que entrega lo vea"
                        },
                        {
                            id: "c",
                            textEn: "Put a triangle sticker",
                            textEs: "Pon una calcomanía triangular"
                        },
                        {
                            id: "d",
                            textEn: "Tell the customer verbally",
                            textEs: "Avísale al cliente verbalmente"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m7-q5",
                    questionEn: "What does CALL IN circled on the ticket mean?",
                    questionEs: "¿Qué significa CALL IN circulado en el ticket?",
                    options: [
                        {
                            id: "a",
                            textEn: "The order is already paid",
                            textEs: "La orden ya está pagada"
                        },
                        {
                            id: "b",
                            textEn: "The handler must take payment when the guest arrives to pick up",
                            textEs: "Quien entrega debe cobrar cuando el cliente llegue a recoger"
                        },
                        {
                            id: "c",
                            textEn: "The kitchen is calling — bring it back",
                            textEs: "La cocina llama — devuelve la orden"
                        },
                        {
                            id: "d",
                            textEn: "The order is a delivery",
                            textEs: "La orden es delivery"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m7-q6",
                    questionEn: "An order takes two bags. How do you tag it?",
                    questionEs: "Una orden requiere dos bolsas. ¿Cómo la marcas?",
                    options: [
                        {
                            id: "a",
                            textEn: "Just bag both — the handler will figure it out",
                            textEs: "Solo empaca las dos — la persona que entrega ya se dará cuenta"
                        },
                        {
                            id: "b",
                            textEn: "Write 'BAG 1 OF 2' on each ticket and staple matching tickets",
                            textEs: "Escribe 'BAG 1 OF 2' en cada ticket y engrapa los tickets correspondientes"
                        },
                        {
                            id: "c",
                            textEn: "Tape the two bags together",
                            textEs: "Pega las dos bolsas con cinta"
                        },
                        {
                            id: "d",
                            textEn: "Verbally tell the cashier",
                            textEs: "Avísale verbalmente al cajero"
                        }
                    ],
                    correct: "b"
                }
            ]
        }
    },
    {
        id: "m8",
        code: "M8",
        track: "stations",
        tier: "all",
        icon: "🍽️",
        durationMin: 15,
        titleEn: "Position: Expo",
        titleEs: "Estación: Expo",
        lessons: [
            {
                id: "m8-l1",
                titleEn: "What Expo Owns + Opening Setup",
                titleEs: "Lo Que Le Toca a Expo + Inicio de Turno",
                contentEn: [
                    "You stand at the food window. You are the kitchen's last set of eyes — every dine-in plate that leaves the line passes through you. You quality-check every plate, you call tickets out loud, you finish the plate (garnish, sauce cup, sides) so it's ready for the food runner to take to the table, and you manage flow when the kitchen gets slammed. Expo is a thinking position.",
                    "Expo handles dine-in plates. To-go bagging is a separate position (the Bagger). The food runner takes plates from your window to the table.",
                    "OPENING SETUP:",
                    "• Apron on. Wash hands. Then clock in — you clock in already in uniform and ready to work (see M2).",
                    "• Wipe down the entire expo line — food window, heat lamps, ice machine, cup sealer, hand sink.",
                    "• Restock the condiment station and utensils.",
                    "• Pull hoisin and sriracha bottles out of the fridge and onto the line. (They live in the fridge overnight, on the line during service.)",
                    "• Confirm the 86'd list, ticket printer paper, and pen at the expo station.",
                    "• Verify the heat lamps are on and at temp.",
                    "• Stock pho garnish trays (thai basil, bean sprouts, lime) — Expo finishes every pho plate with the garnish tray before it leaves the window."
                ],
                contentEs: [
                    "Estás parado en la ventana de comida. Eres el último par de ojos de la cocina — cada plato para comer aquí que sale de la línea pasa por ti. Tú revisas calidad, anuncias tickets en voz alta, terminas el plato (guarnición, vasito de salsa, acompañamientos) para que esté listo para que el food runner lo lleve a la mesa, y manejas el flujo cuando la cocina se atora. Expo es una posición donde tienes que pensar.",
                    "Expo maneja platos para comer aquí. El empaque para llevar es una posición separada (Empaque / Bagger). El food runner lleva platos de tu ventana a la mesa.",
                    "INICIO DE TURNO:",
                    "• Ponte el delantal. Lávate las manos. Luego marca entrada — marcas entrada ya en uniforme y listo para trabajar (ver M2).",
                    "• Limpia toda la línea de expo — ventana de comida, lámparas de calor, máquina de hielo, selladora de vasos, lavamanos.",
                    "• Surte la estación de condimentos y los utensilios.",
                    "• Saca las botellas de hoisin y sriracha del refri y ponlas en la línea. (Viven en el refri de noche, en la línea durante servicio.)",
                    "• Confirma la lista de 86, el papel de la impresora de tickets, y la pluma en la estación de expo.",
                    "• Verifica que las lámparas de calor estén encendidas y a temperatura.",
                    "• Surte bandejas de guarnición de pho (albahaca tailandesa, germinado de soya, limón) — Expo termina cada plato de pho con la bandeja de guarnición antes de salir de la ventana."
                ]
            },
            {
                id: "m8-l2",
                titleEn: "Calling Tickets & Quality Checks",
                titleEs: "Anunciar Tickets y Revisar Calidad",
                contentEn: [
                    "READ EVERY TICKET OUT LOUD as it prints. 'Order in: vermicelli pork, Thai tea, table 7.' Volume matters — the kitchen has to HEAR you over the noise.",
                    "Check every plate before it leaves. Correct protein, correct sauce, correct modifiers, correct sides, looks good. You are the last line of defense before the food hits the guest.",
                    "If a plate is wrong, STOP it. Send it back to the line. Never 'let it slide' because the kitchen is busy. Wrong plates create complaints, refunds, and remakes — all of which cost more time than fixing it now.",
                    "Use kitchen-call language so the team knows what's coming: 'All day, 4 pho, 2 fried rice!' means the total count of each item across all open tickets — 4 pho total, 2 fried rice total. 'Walking with…' means food is leaving the line.",
                    "Quality-check garnish plates on every pho: thai basil, bean sprouts, lime. Every pho gets the FULL garnish. Forgetting garnish on pho is a guest-experience killer.",
                    "Allergy ticket (red in Toast)? Call it out loud with the allergen: 'Allergy order — no peanut!' Confirm with the cook that the protein, sauce, and base were built with clean utensils and fresh gloves — not the ones already in use on the line. Before it leaves the window, have the Shift Lead confirm it's safe. If anything is unclear, hold the plate — never guess."
                ],
                contentEs: [
                    "LEE CADA TICKET EN VOZ ALTA al imprimirse. 'Orden entrando: vermicelli cerdo, té tailandés, mesa 7.' El volumen importa — la cocina debe ESCUCHARTE sobre el ruido.",
                    "Revisa cada plato antes de que salga. Proteína correcta, salsa correcta, modificadores correctos, acompañamientos correctos, se ve bien. Eres la última línea de defensa antes de que la comida llegue al cliente.",
                    "Si un plato está mal, DETÉN la salida. Devuélvelo a la línea. Nunca 'lo dejes pasar' porque la cocina esté ocupada. Los platos mal hechos generan quejas, reembolsos y platos que hay que volver a hacer — todo eso cuesta más tiempo que arreglarlo ahora.",
                    "Usa lenguaje de cocina para que el equipo sepa qué viene: '¡All day, 4 pho, 2 arroz frito!' significa el total de cada platillo en todos los tickets abiertos — 4 pho en total, 2 arroz frito en total. 'Walking with...' significa que la comida ya va saliendo de la línea.",
                    "Revisa los platos de guarnición en cada pho: albahaca tailandesa, germinado de soya, limón. Cada pho lleva la guarnición COMPLETA. Olvidarla en un pho arruina la experiencia del cliente.",
                    "¿Ticket con alergia (rojo en Toast)? Anúncialo en voz alta con el alérgeno: '¡Orden con alergia — sin cacahuate!' Confirma con el cocinero que la proteína, la salsa y la base se prepararon con utensilios limpios y guantes nuevos — no los que ya están en uso en la línea. Antes de que salga de la ventana, que el líder confirme que es seguro. Si algo no está claro, detén el plato — nunca adivines."
                ]
            },
            {
                id: "m8-l3",
                titleEn: "Managing Flow + Restocking",
                titleEs: "Manejar el Flujo y Reabastecer",
                contentEn: [
                    "When pho is slammed, slow down the bowls so the kitchen can catch up. Expo manages flow — you decide what fires next based on cook time and ticket order.",
                    "Communicate with the Shift Lead when a ticket is taking too long: over 10 minutes for a bowl, over 12 minutes for pho. Don't let a long ticket pile up silently.",
                    "Restock the condiment station throughout the shift — never let it run dry. Hoisin, sriracha, sweet chili, peanut, soy, sambal, fish sauce.",
                    "Stay calm during a rush. Expo sets the energy of the kitchen. If you panic, the line panics. If you're calm and clear, the line stays calm and clear.",
                    "If you're slammed and a runner asks 'what's next?' — tell them clearly. Don't make them guess. 'Next out: table 12, pho with brisket.'",
                    "If your window is clear, help Bagging seal and double-check to-go orders — two sets of eyes catch missing items. But the window comes first: during a rush you stay at the line, and you never leave plates under the lamp to go bag."
                ],
                contentEs: [
                    "Cuando el pho está saturado, frena los bowls para que la cocina se ponga al día. Expo maneja el flujo — tú decides qué sale siguiente basado en el tiempo de cocción y el orden de los tickets.",
                    "Comunícate con el líder cuando un ticket tarda demasiado: más de 10 minutos para un bowl, más de 12 minutos para un pho. No dejes que un ticket largo se acumule en silencio.",
                    "Surte la estación de condimentos durante todo el turno — nunca la dejes secar. Hoisin, sriracha, sweet chili, cacahuate, soya, sambal, salsa de pescado.",
                    "Mantén la calma durante un rush. Expo pone la energía de la cocina. Si entras en pánico, la línea entra en pánico. Si estás tranquilo y claro, la línea queda tranquila y clara.",
                    "Si estás saturado y un runner pregunta '¿qué sigue?' — díselo claro. No lo hagas adivinar. 'Sigue: mesa 12, pho con pecho.'",
                    "Si tu ventana está despejada, ayuda a Empaque a sellar y revisar órdenes para llevar — dos pares de ojos atrapan artículos faltantes. Pero la ventana va primero: durante un rush te quedas en la línea, y nunca dejes platos bajo la lámpara por irte a empacar."
                ]
            },
            {
                id: "m8-l4",
                titleEn: "Closing & Common Mistakes",
                titleEs: "Cierre y Errores Comunes",
                contentEn: [
                    "CLOSING — wall checklist is the source of truth.",
                    "• Refill condiment station and wipe it down.",
                    "• Refrigerate hoisin and sriracha bottles.",
                    "• Sweep and mop the hallway behind the line.",
                    "• Collect any remaining dishes from the dining room (do NOT rush guests still eating).",
                    "• Refill cookies in the case if used.",
                    "• Help clean tables and stack chairs.",
                    "• Bring the outside cart in and restock it.",
                    "• Sweep and mop expo and bagging area.",
                    "• Throw away trash.",
                    "COMMON MISTAKES:",
                    "• Letting a wrong plate go out. Expo is the LAST line of defense.",
                    "• Calling tickets quietly. The kitchen needs to HEAR you.",
                    "• Forgetting the garnish plate on pho.",
                    "• Stacking up tickets without telling the Shift Lead the line is backing up.",
                    "• Doing other people's jobs during a rush instead of expo-ing. Stay at the line."
                ],
                contentEs: [
                    "CIERRE — el checklist de la pared es la fuente verdadera.",
                    "• Surte la estación de condimentos y límpiala.",
                    "• Refrigera las botellas de hoisin y sriracha.",
                    "• Barre y mopea el pasillo detrás de la línea.",
                    "• Recoge platos pendientes del comedor (NO apresures a clientes que aún comen).",
                    "• Surte las galletas de la vitrina si se usan.",
                    "• Ayuda a limpiar mesas y a apilar sillas.",
                    "• Mete el carrito de afuera y súrtelo.",
                    "• Barre y mopea el área de expo y empaque.",
                    "• Tira la basura.",
                    "ERRORES COMUNES:",
                    "• Dejar salir un plato mal. Expo es la ÚLTIMA línea de defensa.",
                    "• Anunciar tickets bajito. La cocina debe ESCUCHARTE.",
                    "• Olvidar el plato de guarnición en pho.",
                    "• Acumular tickets sin avisarle al líder que la línea se está atorando.",
                    "• Hacer el trabajo de otros durante un rush en lugar de hacer expo. Quédate en la línea."
                ]
            }
        ],
        quiz: {
            passThreshold: 0.8,
            questions: [
                {
                    id: "m8-q1",
                    questionEn: "Expo's job, in one phrase:",
                    questionEs: "El trabajo de Expo, en una frase:",
                    options: [
                        {
                            id: "a",
                            textEn: "The kitchen's last set of eyes — quality check every plate before it leaves",
                            textEs: "El último par de ojos de la cocina — revisar calidad de cada plato antes de salir"
                        },
                        {
                            id: "b",
                            textEn: "Cooking the food",
                            textEs: "Cocinar la comida"
                        },
                        {
                            id: "c",
                            textEn: "Running food to tables",
                            textEs: "Llevar comida a las mesas"
                        },
                        {
                            id: "d",
                            textEn: "Taking guest orders",
                            textEs: "Tomar órdenes de clientes"
                        }
                    ],
                    correct: "a"
                },
                {
                    id: "m8-q2",
                    questionEn: "Every pho gets:",
                    questionEs: "Cada pho lleva:",
                    options: [
                        {
                            id: "a",
                            textEn: "Just the broth and protein",
                            textEs: "Solo el caldo y la proteína"
                        },
                        {
                            id: "b",
                            textEn: "Full garnish plate: thai basil, bean sprouts, lime",
                            textEs: "Plato completo de guarnición: albahaca tailandesa, germinado de soya, limón"
                        },
                        {
                            id: "c",
                            textEn: "Garnish only if requested",
                            textEs: "Guarnición solo si se pide"
                        },
                        {
                            id: "d",
                            textEn: "Lime only",
                            textEs: "Solo limón"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m8-q3",
                    questionEn: "A plate comes off the line and the protein is wrong. You:",
                    questionEs: "Un plato sale de la línea y la proteína está mal. Tú:",
                    options: [
                        {
                            id: "a",
                            textEn: "Send it out — the kitchen is busy",
                            textEs: "Lo mandas — la cocina está ocupada"
                        },
                        {
                            id: "b",
                            textEn: "Stop it and send it back to the line",
                            textEs: "Lo detienes y lo devuelves a la línea"
                        },
                        {
                            id: "c",
                            textEn: "Add the right protein on top yourself",
                            textEs: "Le agregas la proteína correcta encima tú mismo"
                        },
                        {
                            id: "d",
                            textEn: "Tell the runner to apologize to the guest",
                            textEs: "Le dices al runner que se disculpe con el cliente"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m8-q4",
                    questionEn: "Hoisin and sriracha bottles live where overnight?",
                    questionEs: "¿Dónde viven las botellas de hoisin y sriracha de noche?",
                    options: [
                        {
                            id: "a",
                            textEn: "On the condiment station",
                            textEs: "En la estación de condimentos"
                        },
                        {
                            id: "b",
                            textEn: "On the expo line",
                            textEs: "En la línea de expo"
                        },
                        {
                            id: "c",
                            textEn: "In the fridge",
                            textEs: "En el refrigerador"
                        },
                        {
                            id: "d",
                            textEn: "In the dry storage",
                            textEs: "En el almacén seco"
                        }
                    ],
                    correct: "c"
                },
                {
                    id: "m8-q5",
                    questionEn: "When a bowl ticket is over 10 minutes old, you:",
                    questionEs: "Cuando un ticket de bowl tiene más de 10 minutos, tú:",
                    options: [
                        {
                            id: "a",
                            textEn: "Wait silently for it to come out",
                            textEs: "Esperas en silencio que salga"
                        },
                        {
                            id: "b",
                            textEn: "Tell the Shift Lead",
                            textEs: "Le avisas al líder"
                        },
                        {
                            id: "c",
                            textEn: "Walk to the table and apologize yourself",
                            textEs: "Vas a la mesa y te disculpas tú mismo"
                        },
                        {
                            id: "d",
                            textEn: "Cancel the ticket",
                            textEs: "Cancelas el ticket"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m8-q6",
                    questionEn: "Where should you be during a rush?",
                    questionEs: "¿Dónde debes estar durante un rush?",
                    options: [
                        {
                            id: "a",
                            textEn: "Helping bag every order",
                            textEs: "Ayudando a empacar cada orden"
                        },
                        {
                            id: "b",
                            textEn: "At the expo line",
                            textEs: "En la línea de expo"
                        },
                        {
                            id: "c",
                            textEn: "Running food to tables",
                            textEs: "Llevando comida a las mesas"
                        },
                        {
                            id: "d",
                            textEn: "Cooking on the line to help the kitchen",
                            textEs: "Cocinando en la línea para ayudar a la cocina"
                        }
                    ],
                    correct: "b"
                }
            ]
        }
    },
    {
        id: "m9",
        code: "M9",
        track: "stations",
        tier: "all",
        icon: "🧋",
        durationMin: 15,
        titleEn: "Position: Drinks",
        titleEs: "Estación: Bebidas",
        lessons: [
            {
                id: "m9-l1",
                titleEn: "What Drinks Owns + Opening Setup",
                titleEs: "Lo Que Le Toca a Bebidas + Inicio de Turno",
                contentEn: [
                    "You are the drinks station. You build every boba, fruit tea, milk tea, matcha, Thai tea, masala chai, Vietnamese coffee, lychee limeade, and slushie that goes out the door. The Drink Build Chart at the boba station is your bible — follow it exactly. Don't improvise.",
                    "OPENING SETUP:",
                    "• Apron on. Wash hands. Then clock in — you clock in already in uniform and ready to work (see M2).",
                    "• Cook fresh boba — follow the boba SOP posted at the station.",
                    "• Refill toppings, powders, and syrups so each fridge grid has a container.",
                    "• Make sure there is an extra container of each fruit prepped for the day.",
                    "• Wipe down all boba countertops, the sealer, the blender, the kettle, the warmer.",
                    "• Check tea levels. If any tea is more than 3 days old, throw it away and brew fresh.",
                    "• Refill the condiment station: hoisin, sriracha, sweet chili, peanut, soy, sambal, fish sauce.",
                    "• Restock 12oz cups, 2oz cups, and lids.",
                    "• Restock to-go boxes, pho containers, and lids.",
                    "• Stock napkins.",
                    "• Empty AND wipe/sanitize the water dispenser tray."
                ],
                contentEs: [
                    "Eres la estación de bebidas. Armas cada boba, fruit tea, milk tea, matcha, té tailandés, masala chai, café vietnamita, lychee limeade y slush que sale por la puerta. La Tabla de Bebidas en la estación de boba es tu biblia — síguela exactamente. No improvises.",
                    "INICIO DE TURNO:",
                    "• Ponte el delantal. Lávate las manos. Luego marca entrada — marcas entrada ya en uniforme y listo para trabajar (ver M2).",
                    "• Cocina boba fresca — sigue el SOP de boba en la estación.",
                    "• Surte toppings, polvos y jarabes para que cada espacio del refri tenga su recipiente.",
                    "• Asegúrate de tener un recipiente extra de cada fruta listo para el día.",
                    "• Limpia todos los mostradores de boba, la selladora, la licuadora, la tetera, el calentador.",
                    "• Revisa los niveles de té. Si algún té tiene más de 3 días, tíralo y prepara fresco.",
                    "• Surte la estación de condimentos: hoisin, sriracha, sweet chili, cacahuate, soya, sambal, salsa de pescado.",
                    "• Surte vasos de 12oz, vasos de 2oz, y tapas.",
                    "• Surte cajas para llevar, recipientes de pho, y tapas.",
                    "• Surte servilletas.",
                    "• Vacía Y limpia/desinfecta la bandeja del dispensador de agua."
                ]
            },
            {
                id: "m9-l2",
                titleEn: "Building Drinks — Sweetness, Ice, Shaker Letters",
                titleEs: "Armar Bebidas — Dulzor, Hielo, Letras del Shaker",
                contentEn: [
                    "Build every drink to the Drink Build Chart standard. No improvising. The chart at the station shows the build for all 11 drinks (Black Milk Tea, Jasmine Milk Tea, Brown Sugar Milk Tea, Milk Tea, Fruit Tea, Matcha Milk Tea, Matcha + Fruit, Thai Tea, Masala Chai, Lychee Limeade, Strawberry/Mango Slush).",
                    "SWEETNESS LEVELS — we offer 50% and 100%. Standard is 100%. If a guest asks for 50%, write '50%' on the lid so the next person sees it.",
                    "ICE LEVELS — we offer no ice, half ice, or full ice. Standard is full ice. If they want less, write it on the lid.",
                    "SHAKER LETTERS — the shaker has letters A, B, C, D marked on the side. Use them to measure liquids. The chart tells you which letter for which drink. Eyeballing measurements is the #1 reason a drink tastes wrong.",
                    "ALWAYS shake or stir 8–10 seconds. Undissolved powder is the #1 boba complaint we get. If you can see specks of powder when you hold the cup up to the light, keep stirring.",
                    "SEALER vs LID. Cold drinks get a sealed top from the sealer. Hot drinks get a hot lid. A cold drink with a regular lid will pop in the bag and make a mess.",
                    "HOT DRINKS go in the stainless steel pitcher → milk frother → hot milk setting (per the chart). Don't pour hot tea over ice — that's a different drink."
                ],
                contentEs: [
                    "Arma cada bebida según el estándar de la Tabla de Bebidas. Sin improvisar. La tabla en la estación muestra el build para las 11 bebidas (Black Milk Tea, Jasmine Milk Tea, Brown Sugar Milk Tea, Milk Tea, Fruit Tea, Matcha Milk Tea, Matcha + Fruta, Té Tailandés, Masala Chai, Lychee Limeade, Slush de Fresa/Mango).",
                    "NIVELES DE DULZOR — ofrecemos 50% y 100%. Estándar es 100%. Si un cliente pide 50%, escribe '50%' en la tapa para que el siguiente lo vea.",
                    "NIVELES DE HIELO — ofrecemos sin hielo, medio hielo, o hielo completo. Estándar es hielo completo. Si piden menos, escríbelo en la tapa.",
                    "LETRAS DEL SHAKER — el shaker tiene letras A, B, C, D marcadas en el costado. Úsalas para medir líquidos. La tabla te dice cuál letra para cuál bebida. Adivinar las medidas es la razón #1 por la que una bebida sabe mal.",
                    "SIEMPRE agita o revuelve 8–10 segundos. El polvo sin disolver es la queja #1 de boba que recibimos. Si ves manchitas de polvo cuando levantas el vaso a la luz, sigue revolviendo.",
                    "SELLADORA vs TAPA. Las bebidas frías llevan tapa sellada. Las bebidas calientes llevan tapa caliente. A una bebida fría con tapa regular se le sale la tapa en la bolsa y hace un desastre.",
                    "BEBIDAS CALIENTES van en la jarra de acero inoxidable → espumador de leche → ajuste de leche caliente (según la tabla). No viertas té caliente sobre hielo — esa es otra bebida diferente."
                ]
            },
            {
                id: "m9-l3",
                titleEn: "Tea & Boba Freshness + Special Drinks",
                titleEs: "Frescura de Té y Boba + Bebidas Especiales",
                contentEn: [
                    "TEA SHELF LIFE — 3 days max. Smell it. If it smells off, color looks dark or cloudy, dump it. If you're unsure, dump it. The cost of a wasted pitcher of tea is much less than a sick guest.",
                    "BOBA SHELF LIFE — 4 hours max during service. After 4 hours boba gets hard and chewy in a bad way. We throw away unsold boba at close — 7:45 or 8pm, depending on your location's closing time. Boba pearls left in water overnight grow film — rinse the pot at close.",
                    "VIETNAMESE COFFEE uses condensed milk. That's the recipe. If a guest asks for 'sugar and cream instead,' tell them it's a fundamentally different drink and we don't make that swap. The condensed milk IS the drink.",
                    "⚠ BOBA MILK TEA CREAMER — what's in the bag matters. Our milk-tea base uses a milk-powder mix that already has the non-dairy creamer blended in. The bag lists sodium caseinate, lactose, and milk flavor in the ingredients. Those ARE milk derivatives, and they are IN the base — we CAN'T take them out. If a guest tells the cashier they have a milk allergy and the cashier didn't catch it, we don't fix it at the boba station by making it 'extra non-dairy' or by swapping the milk — the allergen is in the base. STOP THE BUILD, walk to the cashier, and we redirect the guest to a FRUIT TEA — the only safe option on the boba menu for a milk allergy (fruit teas never touch the milk powder; Matcha Latte, Masala Chai and Thai Tea are different — real milk is added per drink, so oat or soy is a safe sub there, see M17). If they're lactose-intolerant (digestion only, not allergy), our milk teas are usually fine for them. Allergy = fruit tea, no exceptions.",
                    "MATCHA AND BROWN SUGAR — never below 50%. Guests sometimes ask for 25% or 'no sugar.' We don't do that on any drink (we offer 100% and 50% only), and on these two it also ruins the drink: at 25% or 0% matcha gets bitter and brown sugar isn't brown sugar. Say it politely — 'we recommend 50% on matcha so it doesn't get bitter, want to try that?'",
                    "WATER DISPENSER TRAY needs to be emptied AND wiped/sanitized daily, not just emptied. Standing water grows bacteria fast.",
                    "Restock condiments and to-go supplies between every rush — your station feeds expo and bagging.",
                    "Phones stay in the back. Eating/drinking at the boba station is a no.",
                    "If a guest asks about a drink we don't make, say 'we don't make that, but we do have…' and recommend the closest thing on the chart. Don't try to invent."
                ],
                contentEs: [
                    "VIDA ÚTIL DEL TÉ — 3 días máximo. Huélelo. Si huele raro, el color se ve oscuro o turbio, tíralo. Si dudas, tíralo. El costo de una jarra de té desperdiciada es mucho menor que el de un cliente enfermo.",
                    "VIDA ÚTIL DEL BOBA — 4 horas máximo durante el servicio. Después de 4 horas el boba se pone duro y chicloso. Tiramos el boba sin vender al cierre — 7:45 u 8pm, según la hora de cierre de tu local. Las perlas de boba que quedan en agua toda la noche generan película — enjuaga la olla al cierre.",
                    "EL CAFÉ VIETNAMITA usa leche condensada. Esa es la receta. Si un cliente pide 'azúcar y crema en vez,' dile que es una bebida fundamentalmente diferente y no hacemos ese cambio. La leche condensada ES la bebida.",
                    "⚠ CREMA DE BOBA MILK TEA — lo que está en la bolsa importa. Nuestra base de milk tea usa una leche en polvo que YA tiene la crema non-dairy mezclada. La bolsa lista caseinato de sodio, lactosa y sabor de leche en los ingredientes. Esos SÍ son derivados lácteos, y YA ESTÁN en la base — NO los podemos quitar. Si un cliente le dice al cajero que tiene alergia a la leche y el cajero no lo notó, NO lo arreglamos en la estación de boba haciéndolo 'extra non-dairy' ni cambiando la leche — el alérgeno está en la base. PARA EL BUILD, ve con el cajero, y redirigimos al cliente a un FRUIT TEA — la única opción segura del menú de boba para alergia a la leche (los fruit teas nunca tocan la leche en polvo; Matcha Latte, Masala Chai y Thai Tea son diferentes — la leche se agrega por bebida, así que ahí avena o soya sí es sustituto seguro, ver M17). Si es intolerante a la lactosa (solo digestión, no alergia), los milk teas usualmente están bien. Alergia = fruit tea, sin excepciones.",
                    "MATCHA Y BROWN SUGAR — nunca menos de 50%. A veces un cliente pide 25% o 'sin azúcar.' No lo hacemos en ninguna bebida (ofrecemos solo 100% y 50%), y en estas dos además arruina la bebida: a 25% o 0% el matcha se pone amargo y el brown sugar no es brown sugar. Díselo amablemente — 'recomendamos 50% en matcha para que no se ponga amargo, ¿quieres probarlo?'",
                    "LA BANDEJA DEL DISPENSADOR DE AGUA se debe vaciar Y limpiar/desinfectar diariamente, no solo vaciar. El agua estancada genera bacterias rápido.",
                    "Surte condimentos y suministros para llevar entre cada rush — tu estación alimenta a expo y empaque.",
                    "Los teléfonos se quedan atrás. Comer/beber en la estación de boba no se permite.",
                    "Si un cliente pregunta por una bebida que no hacemos, di 'esa no la hacemos, pero tenemos…' y recomienda lo más parecido en la tabla. No intentes inventar."
                ]
            },
            {
                id: "m9-l4",
                titleEn: "Closing & Common Mistakes",
                titleEs: "Cierre y Errores Comunes",
                contentEn: [
                    "CLOSING — wall checklist is the source of truth.",
                    "• Throw away boba at close (7:45 or 8pm, per your location).",
                    "• Bring teas back to the wash container or throw away (3-day rule).",
                    "• Turn off ALL items: boba sealer, blender, water kettle, boba warmer.",
                    "• Wipe down countertops, the fridge interior, and the sealer.",
                    "• Refill the condiment station.",
                    "• Wipe down the condiment station.",
                    "• Refrigerate hoisin and sriracha bottles.",
                    "• Sweep/mop the boba station and the hallway.",
                    "• Bring all boba utensils, scoops, and mats to the dish pit to wash.",
                    "• Make sure the sanitizer bucket is empty before clocking out.",
                    "COMMON MISTAKES:",
                    "• Eyeballing measurements instead of using the shaker letters (A/B/C/D).",
                    "• Not shaking/stirring long enough — undissolved powder ruins the drink.",
                    "• Using boba that has been sitting more than 4 hours.",
                    "• Using tea more than 3 days old. Smell it. If unsure, dump it.",
                    "• Forgetting to seal cold drinks.",
                    "• Substituting sugar+cream for condensed milk on Vietnamese coffee. Don't do it.",
                    "• Letting a guest drop matcha or brown sugar below 50% — drink will taste bad and you'll get the complaint."
                ],
                contentEs: [
                    "CIERRE — el checklist de la pared es la fuente verdadera.",
                    "• Tira el boba al cierre (7:45 u 8pm, según tu local).",
                    "• Lleva los tés al recipiente de lavado o tíralos (regla de 3 días).",
                    "• Apaga TODO: selladora de boba, licuadora, tetera, calentador de boba.",
                    "• Limpia mostradores, el interior del refri, y la selladora.",
                    "• Surte la estación de condimentos.",
                    "• Limpia la estación de condimentos.",
                    "• Refrigera las botellas de hoisin y sriracha.",
                    "• Barre/mopea la estación de boba y el pasillo.",
                    "• Lleva todos los utensilios, cucharones y tapetes de boba al área de lavado.",
                    "• Asegúrate de que la cubeta de desinfectante esté vacía antes de marcar salida.",
                    "ERRORES COMUNES:",
                    "• Adivinar medidas en lugar de usar las letras del shaker (A/B/C/D).",
                    "• No agitar/revolver lo suficiente — el polvo sin disolver arruina la bebida.",
                    "• Usar boba que tiene más de 4 horas.",
                    "• Usar té de más de 3 días. Huélelo. Si dudas, tíralo.",
                    "• Olvidar sellar bebidas frías.",
                    "• Sustituir azúcar+crema por leche condensada en el café vietnamita. No lo hagas.",
                    "• Dejar que un cliente baje el matcha o brown sugar a menos de 50% — la bebida sabrá mal y la queja te llega a ti."
                ]
            }
        ],
        quiz: {
            passThreshold: 0.8,
            questions: [
                {
                    id: "m9-q1",
                    questionEn: "How long should you shake or stir a drink?",
                    questionEs: "¿Cuánto debes agitar o revolver una bebida?",
                    options: [
                        {
                            id: "a",
                            textEn: "2-3 seconds",
                            textEs: "2-3 segundos"
                        },
                        {
                            id: "b",
                            textEn: "8-10 seconds",
                            textEs: "8-10 segundos"
                        },
                        {
                            id: "c",
                            textEn: "20+ seconds",
                            textEs: "20+ segundos"
                        },
                        {
                            id: "d",
                            textEn: "Until your arm gets tired",
                            textEs: "Hasta que se canse el brazo"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m9-q2",
                    questionEn: "Tea is good for how many days?",
                    questionEs: "¿Por cuántos días se puede usar el té?",
                    options: [
                        {
                            id: "a",
                            textEn: "1 day",
                            textEs: "1 día"
                        },
                        {
                            id: "b",
                            textEn: "3 days max — smell it; if unsure, dump it",
                            textEs: "3 días máx — huélelo; si dudas, tíralo"
                        },
                        {
                            id: "c",
                            textEn: "1 week",
                            textEs: "1 semana"
                        },
                        {
                            id: "d",
                            textEn: "Until it's gone",
                            textEs: "Hasta que se acabe"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m9-q3",
                    questionEn: "What sweetness levels do we offer?",
                    questionEs: "¿Qué niveles de dulzor ofrecemos?",
                    options: [
                        {
                            id: "a",
                            textEn: "0%, 25%, 50%, 75%, 100%",
                            textEs: "0%, 25%, 50%, 75%, 100%"
                        },
                        {
                            id: "b",
                            textEn: "50% and 100% — 100% is standard",
                            textEs: "50% y 100% — 100% es estándar"
                        },
                        {
                            id: "c",
                            textEn: "Whatever the guest wants",
                            textEs: "Lo que el cliente quiera"
                        },
                        {
                            id: "d",
                            textEn: "100% only",
                            textEs: "Solo 100%"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m9-q4",
                    questionEn: "How do you measure liquids on the build chart?",
                    questionEs: "¿Cómo mides líquidos según la tabla de bebidas?",
                    options: [
                        {
                            id: "a",
                            textEn: "Eyeball it — you'll learn the right amount with practice",
                            textEs: "Adivínalo — aprenderás la cantidad con práctica"
                        },
                        {
                            id: "b",
                            textEn: "Use the shaker letters (A, B, C, D) marked on the side",
                            textEs: "Usa las letras del shaker (A, B, C, D) marcadas en el costado"
                        },
                        {
                            id: "c",
                            textEn: "Pour to the rim",
                            textEs: "Llena hasta el borde"
                        },
                        {
                            id: "d",
                            textEn: "Use a measuring cup",
                            textEs: "Usa una taza medidora"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m9-q5",
                    questionEn: "Cold drink gets which top?",
                    questionEs: "¿Qué tapa lleva una bebida fría?",
                    options: [
                        {
                            id: "a",
                            textEn: "Hot lid",
                            textEs: "Tapa caliente"
                        },
                        {
                            id: "b",
                            textEn: "Sealed top from the sealer",
                            textEs: "Tapa sellada de la selladora"
                        },
                        {
                            id: "c",
                            textEn: "No top",
                            textEs: "Sin tapa"
                        },
                        {
                            id: "d",
                            textEn: "Plastic wrap",
                            textEs: "Plástico"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m9-q6",
                    questionEn: "A guest asks for Vietnamese coffee with sugar and cream instead of condensed milk. You:",
                    questionEs: "Un cliente pide café vietnamita con azúcar y crema en vez de leche condensada. Tú:",
                    options: [
                        {
                            id: "a",
                            textEn: "Make it however they want",
                            textEs: "Lo haces como quiera"
                        },
                        {
                            id: "b",
                            textEn: "Politely tell them it's a fundamentally different drink — Vietnamese coffee uses condensed milk by design",
                            textEs: "Le dices amablemente que es una bebida fundamentalmente diferente — el café vietnamita usa leche condensada por diseño"
                        },
                        {
                            id: "c",
                            textEn: "Charge extra for the modification",
                            textEs: "Cobras extra por la modificación"
                        },
                        {
                            id: "d",
                            textEn: "Refuse and say nothing",
                            textEs: "Rechazas y no dices nada"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m9-q7",
                    questionEn: "You're mid-build on a Black Milk Tea and the cashier says the guest just mentioned a milk allergy. You:",
                    questionEs: "Estás armando un Black Milk Tea y el cajero dice que el cliente acaba de mencionar alergia a la leche. Tú:",
                    options: [
                        {
                            id: "a",
                            textEn: "Swap in oat milk — that removes the dairy",
                            textEs: "Cambias a leche de avena — eso quita el lácteo"
                        },
                        {
                            id: "b",
                            textEn: "Stop the build and redirect the guest to a fruit tea — the creamer is pre-mixed in the milk-tea base and can't be removed",
                            textEs: "Paras el build y rediriges al cliente a un fruit tea — la crema viene pre-mezclada en la base del milk tea y no se puede quitar"
                        },
                        {
                            id: "c",
                            textEn: "Make it 'extra non-dairy' and finish the drink",
                            textEs: "Lo haces 'extra non-dairy' y terminas la bebida"
                        },
                        {
                            id: "d",
                            textEn: "Finish it — the bag says non-dairy so it's fine",
                            textEs: "La terminas — la bolsa dice non-dairy, así que está bien"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m9-q8",
                    questionEn: "Cooked boba is good for how long during service?",
                    questionEs: "¿Cuánto tiempo dura el boba cocido durante el servicio?",
                    options: [
                        {
                            id: "a",
                            textEn: "1 hour",
                            textEs: "1 hora"
                        },
                        {
                            id: "b",
                            textEn: "4 hours max — then it gets hard, throw it out",
                            textEs: "4 horas máx — después se pone duro, tíralo"
                        },
                        {
                            id: "c",
                            textEn: "All day",
                            textEs: "Todo el día"
                        },
                        {
                            id: "d",
                            textEn: "Until close",
                            textEs: "Hasta el cierre"
                        }
                    ],
                    correct: "b"
                }
            ]
        }
    },
    {
        id: "m10",
        code: "M10",
        track: "manager-ops",
        tier: "lead",
        icon: "🛡️",
        durationMin: 25,
        titleEn: "Shift Lead Duties",
        titleEs: "Deberes del Líder de Turno",
        lessons: [
            {
                id: "m10-l1",
                titleEn: "What the Shift Lead Owns",
                titleEs: "Lo Que Le Toca al Líder de Turno",
                contentEn: [
                    "Shift Lead is not its own position — it's a set of responsibilities you take on for the day, on top of working a regular station (Cashier, Bagger, Expo, Drinks, or Food Runner). Every shift, one person is designated the Lead. You own the floor. The team works the stations; you make sure the stations are working.",
                    "What you own:",
                    "• The pre-shift line check (open) and post-shift line check (close).",
                    "• The cash drawer — opening bank, voids/refunds/comps, closing count.",
                    "• The 86 list and inventory call-outs ('we are running low on lemongrass shrimp, sub it for chicken').",
                    "• Allergen calls — when a guest has an allergy, you confirm what is safe.",
                    "• Guest complaints that escalate past the front-line team (RESTORE handoff).",
                    "• Team accountability — who is on time, who is signed off on duties, who needs coaching.",
                    "• The shift report — sales, cash, food waste, callouts, incidents.",
                    "• Locking up at close.",
                    "Front-line team members do NOT have void/refund/comp authority. That's you. They do NOT count the cash drawer alone. That's also you (with one team member).",
                    "When a complaint gets handed to you, you run RESTORE: listen fully and apologize sincerely (no excuses, no blaming the kitchen), fix it fast (remake, replace, or comp — that's why you have comp authority), add something extra when it fits (a drink or a snack), circle back before the guest leaves, and log it in the shift report so we can fix the root cause."
                ],
                contentEs: [
                    "Líder de Turno no es una posición propia — es un conjunto de responsabilidades que tomas para el día, además de trabajar una estación regular (Cajero, Empaque, Expo, Bebidas o Food Runner). Cada turno, una persona es designada como el Líder. El piso es tu responsabilidad. El equipo trabaja las estaciones; tú aseguras que las estaciones estén funcionando.",
                    "Lo que te toca:",
                    "• El line check de pre-turno (apertura) y post-turno (cierre).",
                    "• La caja registradora — banco inicial, voids/reembolsos/comps, conteo de cierre.",
                    "• La lista de 86 y avisos de inventario ('se nos está acabando el camarón con hierba limón, cámbienlo por pollo').",
                    "• Decisiones de alergia — cuando un cliente tiene alergia, tú confirmas qué es seguro.",
                    "• Quejas de cliente que escalen más allá del equipo de primera línea (entrega RESTORE).",
                    "• Responsabilidad del equipo — quién llega a tiempo, quién ya tiene sus deberes firmados, quién necesita coaching.",
                    "• El reporte de turno — ventas, efectivo, desperdicio de comida, faltas, incidentes.",
                    "• Cerrar con llave al final del día.",
                    "Los miembros del equipo de primera línea NO tienen autoridad de voids/reembolsos/comps. Esa es tuya. Ellos NO cuentan la caja solos. Eso también es tuyo (con un miembro del equipo).",
                    "Cuando te pasan una queja, tú manejas RESTORE: escucha completo y discúlpate con sinceridad (sin excusas, sin culpar a la cocina), arréglalo rápido (rehacer, reemplazar o comp — por eso tienes autoridad de comps), agrega algo extra cuando aplique (una bebida o un snack), regresa con el cliente antes de que se vaya, y anótalo en el reporte de turno para corregir la causa de fondo."
                ]
            },
            {
                id: "m10-l2",
                titleEn: "Pre-Shift Line Check (Opening)",
                titleEs: "Line Check de Pre-Turno (Apertura)",
                contentEn: [
                    "Done at least 30 minutes before doors open. Walk the kitchen with the Pre-Shift Line Check sheet.",
                    "TEMPS:",
                    "• Take cooler temps. Log them. Anything reading above 41°F gets pulled or moved to a working unit.",
                    "• Take freezer temp. Log it. Anything above 0°F gets investigated.",
                    "• Verify hot-hold (broth, fried rice line) is at 135°F or above.",
                    "FRESHNESS:",
                    "• Smell-check all teas. Anything 3+ days old goes.",
                    "• Check pho broth — proper temp, color, no funk.",
                    "• Walk the prep list — what is done, what is short. Adjust the day's prep priorities.",
                    "SAFETY:",
                    "• Check sani buckets — fresh, 200–400 ppm. Test with a quat strip; should turn dark blue.",
                    "• Confirm the 86'd list in Toast and post it visible at register and expo.",
                    "DINING ROOM:",
                    "• Walk the dining room — clean tables, stocked condiment bar, restrooms checked and signed.",
                    "PRE-SHIFT HUDDLE:",
                    "• 5-minute team meeting before doors open. Cover today's 86s, expected volume, anything special (event, large catering order, allergy guest with a reservation, etc.)."
                ],
                contentEs: [
                    "Se hace al menos 30 minutos antes de abrir. Camina la cocina con la hoja de Line Check de Pre-Turno.",
                    "TEMPERATURAS:",
                    "• Toma temperaturas de coolers. Regístralas. Cualquier cosa arriba de 41°F se saca o se mueve a una unidad funcionando.",
                    "• Toma temperatura del congelador. Regístrala. Arriba de 0°F se investiga.",
                    "• Verifica que el hot-hold (caldo, línea de arroz frito) esté a 135°F o más.",
                    "FRESCURA:",
                    "• Huele todos los tés. Cualquier cosa de 3+ días se va.",
                    "• Revisa el caldo de pho — temperatura, color, sin olor raro.",
                    "• Camina la lista de prep — qué está listo, qué falta. Ajusta las prioridades del día.",
                    "SEGURIDAD:",
                    "• Revisa cubetas de desinfectante — frescas, 200–400 ppm. Prueba con tira quat; debe ponerse azul oscuro.",
                    "• Confirma la lista de 86 en Toast y colócala a la vista en caja y expo.",
                    "COMEDOR:",
                    "• Camina el comedor — mesas limpias, bar de condimentos surtido, baños revisados y firmados.",
                    "REUNIÓN DE PRE-TURNO:",
                    "• Reunión de 5 minutos con el equipo antes de abrir. Cubre los 86 del día, volumen esperado, algo especial (evento, orden grande de catering, cliente con alergia con reservación, etc.)."
                ]
            },
            {
                id: "m10-l3",
                titleEn: "Mid-Shift Pulse + 86 Management",
                titleEs: "Chequeo de Medio Turno + Manejo de 86",
                contentEn: [
                    "At the 4-hour mark of a shift (or after the lunch rush), do a 10-minute walkthrough.",
                    "• Re-check sani buckets — refresh if cloudy or past 4 hours.",
                    "• Re-check cooler/hot-hold temps. Log them.",
                    "• Refresh the 86'd list — anything else we are running out of? Update the Toast 86 menu so the register sees the change in real time.",
                    "• Check team accountability — are people on their stations? Are bathrooms checked? Are condiments stocked? Are there team members who need a quick coaching moment?",
                    "We do NOT do a mid-shift cash skim — the drawer is counted at close, not split during the shift.",
                    "86 MANAGEMENT — three rules:",
                    "1. The moment a cook tells you we're out of something, update Toast immediately. Don't wait for the register to ring it through and have the kitchen reject it.",
                    "2. If we're getting close (lemongrass shrimp down to 1 bag), give the register a heads-up before you 86 it so they can soft-pitch a different protein.",
                    "3. Tell the team in the next station rotation which substitutions are easy ('we're 86 lemongrass shrimp; suggest grilled chicken')."
                ],
                contentEs: [
                    "A las 4 horas del turno (o después del rush del almuerzo), haz un recorrido de 10 minutos.",
                    "• Revisa de nuevo las cubetas de desinfectante — refréscalas si están turbias o pasadas de 4 horas.",
                    "• Revisa de nuevo temperaturas de cooler/hot-hold. Regístralas.",
                    "• Actualiza la lista de 86 — ¿de qué más nos estamos quedando? Actualiza el menú de 86 en Toast para que la caja vea el cambio al instante.",
                    "• Revisa la responsabilidad del equipo — ¿están en sus estaciones? ¿Se están revisando los baños? ¿Están surtidos los condimentos? ¿Hay miembros que necesiten un momento rápido de coaching?",
                    "NO hacemos skim de efectivo a mitad de turno — la caja se cuenta al cierre, no se divide durante el turno.",
                    "MANEJO DE 86 — tres reglas:",
                    "1. En el momento que un cocinero te diga que se acabó algo, actualiza Toast inmediatamente. No esperes a que la caja lo cobre y la cocina lo rechace.",
                    "2. Si ya casi se acaba (queda 1 bolsa de camarón con hierba limón), avísale a la caja antes de ponerlo en 86 para que sugieran suavemente otra proteína.",
                    "3. Dile al equipo en la siguiente rotación qué sustituciones son fáciles ('el camarón con hierba limón está en 86; sugieran pollo a la parrilla')."
                ]
            },
            {
                id: "m10-l4",
                titleEn: "Cash Handling, Voids, Comps & Closing Count",
                titleEs: "Manejo de Efectivo, Voids, Comps y Conteo de Cierre",
                contentEn: [
                    "OPENING BANK is $300. Verify with the off-going manager (or open the safe and pull it yourself if you're the AM lead). The team member at register signs the cash sheet at open.",
                    "VOIDS, REFUNDS, COMPS — only Shift Leads process these. Front-line team members never have permission. Andrew has set the policy: Shift Lead has FULL authority for voids, refunds, and comps; you do not need to escalate to GM by dollar amount.",
                    "Every void over $5 logs on the Voids Tracker with reason and Toast ticket number. Every comp logs on the Comps Tracker with reason. The trackers exist for accountability, not blame — they let us see patterns (e.g., a single dish getting comp'd repeatedly = a quality problem to fix).",
                    "NO MID-SHIFT SKIM. The drawer is counted at close, not pulled mid-shift.",
                    "CLOSING COUNT is done by TWO people — the Shift Lead and one team member. Never alone. Two people protects you and protects them.",
                    "If you're short or over by more than $20, document it on the cash sheet, call the GM, and don't try to 'fix' the count by adjusting numbers. We document the variance and investigate.",
                    "POSSIBLE ALLERGIC REACTION — the one escalation that cannot wait. If a guest says they are reacting: (1) stop serving that dish and pull it from the table; (2) ask if they need medical help — call 911 if it is severe (trouble breathing, swelling of lips/face/throat, spreading hives); (3) do NOT say 'it shouldn't have that in it' — help the guest, don't defend the kitchen; (4) call the GM right away, not within the hour; (5) write down what was ordered, what was served, who prepared it and what went wrong, and put it in the shift report.",
                    "WHEN TO ESCALATE TO GM (call within the hour):",
                    "• Any cash discrepancy over $20.",
                    "• Any guest complaint involving a possible allergic reaction (immediately — see above).",
                    "• Any team injury that requires more than a bandage.",
                    "• Any equipment failure affecting food safety (cooler down, hot-hold not holding).",
                    "• Any team conflict you can't resolve on the floor.",
                    "• Any visit from a health inspector (GM on the phone within 5 minutes).",
                    "• Any no-call/no-show or walkout."
                ],
                contentEs: [
                    "EL BANCO INICIAL es de $300. Verifica con el manager saliente (o abre la caja fuerte y sácalo tú si eres el AM lead). El miembro del equipo en caja firma la hoja de caja al abrir.",
                    "VOIDS, REEMBOLSOS, COMPS — solo los líderes los procesan. Los miembros de primera línea nunca tienen permiso. Andrew estableció la política: el líder tiene autoridad COMPLETA en voids, reembolsos y comps; no necesitas escalar al GM por monto.",
                    "Cada void de más de $5 se registra en el Voids Tracker con razón y número de ticket de Toast. Cada comp se registra en el Comps Tracker con razón. Los trackers existen por responsabilidad, no por culpa — nos permiten ver patrones (un platillo que se regala (comp) una y otra vez = un problema de calidad que arreglar).",
                    "SIN SKIM A MITAD DE TURNO. La caja se cuenta al cierre, no se saca a mitad de turno.",
                    "EL CONTEO DE CIERRE lo hacen DOS personas — el Líder y un miembro del equipo. Nunca solo. Dos personas te protegen a ti y a ellos.",
                    "Si estás corto o sobrado por más de $20, documéntalo en la hoja de caja, llama al GM, y no intentes 'arreglar' el conteo ajustando números. Documentamos la diferencia e investigamos.",
                    "POSIBLE REACCIÓN ALÉRGICA — la única escalación que no puede esperar. Si un cliente dice que está reaccionando: (1) deja de servir ese platillo y retíralo de la mesa; (2) pregúntale si necesita ayuda médica — llama al 911 si es grave (dificultad para respirar, hinchazón de labios/cara/garganta, ronchas que se extienden); (3) NO digas 'eso no debería llevar eso' — ayuda al cliente, no defiendas a la cocina; (4) llama al GM de inmediato, no dentro de la hora; (5) anota qué se ordenó, qué se sirvió, quién lo preparó y qué salió mal, y ponlo en el reporte de turno.",
                    "CUÁNDO ESCALAR AL GM (llama dentro de la hora):",
                    "• Cualquier diferencia de caja de más de $20.",
                    "• Cualquier queja de cliente que involucre una posible reacción alérgica (de inmediato — ver arriba).",
                    "• Cualquier lesión del equipo que requiera más que una bandita.",
                    "• Cualquier falla de equipo que afecte la seguridad alimentaria (cooler caído, hot-hold que no mantiene temperatura).",
                    "• Cualquier conflicto del equipo que no puedas resolver en el piso.",
                    "• Cualquier visita de un inspector de salud (GM al teléfono en 5 minutos).",
                    "• Cualquier no-call/no-show o walkout."
                ]
            },
            {
                id: "m10-l5",
                titleEn: "End-of-Shift Report + Closing Walkthrough",
                titleEs: "Reporte de Fin de Turno + Recorrido de Cierre",
                contentEn: [
                    "END-OF-SHIFT REPORT — fill out and email the GM (or drop in the binder per location practice). Required fields:",
                    "• Sales total (from Toast).",
                    "• Cash variance (over/short).",
                    "• Food waste (what was thrown away — pho broth, prepped proteins, expired produce — and approximate dollar value).",
                    "• 86'd items (what ran out and roughly what time).",
                    "• Callouts (who called out, when, why if known).",
                    "• Incidents (guest complaints, injuries, equipment issues, anything unusual).",
                    "• Tomorrow's prep priorities (what's short for the morning shift).",
                    "CLOSING SIGN-OFF — walk the closing checklist (3-person or 4-person version, posted on the wall) and sign off each section before the team clocks out:",
                    "• Bagging/Expo — countertops wiped, pho plates put away, expo line restocked, milk and cakes in fridge.",
                    "• Register — drawer counted, sodas restocked, dining room cleaned, chairs up.",
                    "• Drinks (Boba) — boba dumped, items off, condiment station refilled, sweep/mop done.",
                    "• Food Runner / Dining Room — tables and chairs wiped, condiment bar and silverware restocked, number tents back at the register, bus tubs to the dish pit, floor swept/mopped.",
                    "• Restrooms — locked, lights off, log signed.",
                    "• Lockup — back door locked, alarm set, lights off, open sign (it's on a timer — just confirm it went off).",
                    "DON'T let anyone clock out before you've initialed their section on the wall checklist. If the floor isn't right when you walk it, the team stays until it is — be kind, be firm, every time. This one rule prevents most closing slippage."
                ],
                contentEs: [
                    "REPORTE DE FIN DE TURNO — llénalo y mándalo por correo al GM (o déjalo en el binder según la práctica de la ubicación). Campos requeridos:",
                    "• Total de ventas (de Toast).",
                    "• Diferencia de caja (sobrado/corto).",
                    "• Desperdicio de comida (qué se tiró — caldo de pho, proteínas ya preparadas, verdura caducada — y valor aproximado en dólares).",
                    "• Artículos en 86 (qué se acabó y más o menos a qué hora).",
                    "• Faltas (quién faltó, cuándo, razón si se sabe).",
                    "• Incidentes (quejas de clientes, lesiones, problemas de equipo, cualquier cosa inusual).",
                    "• Prioridades de prep para mañana (qué falta para el turno de la mañana).",
                    "FIRMA DE CIERRE — camina el checklist de cierre (versión de 3 personas o 4 personas, pegado en la pared) y firma cada sección antes de que el equipo marque salida:",
                    "• Bagging/Expo — mostradores limpios, platos de pho guardados, línea de expo surtida, leche y pasteles en el refri.",
                    "• Caja — caja contada, sodas surtidas, comedor limpio, sillas arriba.",
                    "• Bebidas (Boba) — boba tirado, equipos apagados, estación de condimentos surtida, barrido/trapeado hecho.",
                    "• Food Runner / Comedor — mesas y sillas limpias, bar de condimentos y cubiertos surtidos, números de mesa de regreso en la caja, bus tubs al área de lavado, piso barrido/trapeado.",
                    "• Baños — cerrados con llave, luces apagadas, log firmado.",
                    "• Cierre del local — puerta trasera cerrada con llave, alarma puesta, luces apagadas, letrero de OPEN (tiene temporizador — solo confirma que se apagó).",
                    "NO dejes que nadie marque salida antes de que hayas firmado con tus iniciales su sección en el checklist de la pared. Si el piso no está bien cuando lo recorres, el equipo se queda hasta que lo esté — amable pero firme, cada vez. Esta sola regla evita la mayoría de los descuidos del cierre."
                ]
            }
        ],
        quiz: {
            passThreshold: 0.85,
            questions: [
                {
                    id: "m10-q1",
                    questionEn: "What's the opening cash bank?",
                    questionEs: "¿Cuál es el banco inicial?",
                    options: [
                        {
                            id: "a",
                            textEn: "$100",
                            textEs: "$100"
                        },
                        {
                            id: "b",
                            textEn: "$200",
                            textEs: "$200"
                        },
                        {
                            id: "c",
                            textEn: "$300",
                            textEs: "$300"
                        },
                        {
                            id: "d",
                            textEn: "$500",
                            textEs: "$500"
                        }
                    ],
                    correct: "c"
                },
                {
                    id: "m10-q2",
                    questionEn: "Who counts the closing drawer?",
                    questionEs: "¿Quién cuenta la caja al cierre?",
                    options: [
                        {
                            id: "a",
                            textEn: "Shift Lead alone",
                            textEs: "El Líder solo"
                        },
                        {
                            id: "b",
                            textEn: "Shift Lead + one team member, never alone",
                            textEs: "El Líder + un miembro del equipo, nunca solo"
                        },
                        {
                            id: "c",
                            textEn: "Whoever is at register that night",
                            textEs: "Quien sea que esté en caja esa noche"
                        },
                        {
                            id: "d",
                            textEn: "The GM only",
                            textEs: "Solo el GM"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m10-q3",
                    questionEn: "Pre-shift line check happens:",
                    questionEs: "El line check de pre-turno se hace:",
                    options: [
                        {
                            id: "a",
                            textEn: "Right when you walk in the door",
                            textEs: "Apenas entras por la puerta"
                        },
                        {
                            id: "b",
                            textEn: "At least 30 minutes before doors open",
                            textEs: "Al menos 30 minutos antes de abrir puertas"
                        },
                        {
                            id: "c",
                            textEn: "After the lunch rush",
                            textEs: "Después del rush de almuerzo"
                        },
                        {
                            id: "d",
                            textEn: "Only on weekends",
                            textEs: "Solo los fines de semana"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m10-q4",
                    questionEn: "Sani bucket spec is:",
                    questionEs: "La especificación de cubeta de desinfectante es:",
                    options: [
                        {
                            id: "a",
                            textEn: "100-200 ppm quat, light blue strip",
                            textEs: "100-200 ppm quat, tira azul claro"
                        },
                        {
                            id: "b",
                            textEn: "200-400 ppm quat, dark blue strip",
                            textEs: "200-400 ppm quat, tira azul oscuro"
                        },
                        {
                            id: "c",
                            textEn: "Bleach water, no test needed",
                            textEs: "Agua con cloro, sin necesidad de prueba"
                        },
                        {
                            id: "d",
                            textEn: "Whatever the bucket says",
                            textEs: "Lo que diga la cubeta"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m10-q5",
                    questionEn: "A guest reports a possible allergic reaction. You:",
                    questionEs: "Un cliente reporta una posible reacción alérgica. Tú:",
                    options: [
                        {
                            id: "a",
                            textEn: "Comp the meal and move on",
                            textEs: "Comp la comida y sigue"
                        },
                        {
                            id: "b",
                            textEn: "Tell them it's probably nothing",
                            textEs: "Dile que probablemente no es nada"
                        },
                        {
                            id: "c",
                            textEn: "Make sure the guest is safe (911 if severe), then call the GM immediately",
                            textEs: "Asegúrate de que el cliente esté bien (911 si es grave) y llama al GM de inmediato"
                        },
                        {
                            id: "d",
                            textEn: "Have the cook explain the recipe",
                            textEs: "Haz que el cocinero explique la receta"
                        }
                    ],
                    correct: "c"
                },
                {
                    id: "m10-q6",
                    questionEn: "Do we do a mid-shift cash skim?",
                    questionEs: "¿Hacemos skim de efectivo a mitad de turno?",
                    options: [
                        {
                            id: "a",
                            textEn: "Yes, when the drawer hits $300",
                            textEs: "Sí, cuando la caja llegue a $300"
                        },
                        {
                            id: "b",
                            textEn: "No — drawer is counted at close, not pulled mid-shift",
                            textEs: "No — la caja se cuenta al cierre, no se saca a mitad de turno"
                        },
                        {
                            id: "c",
                            textEn: "Only on weekends",
                            textEs: "Solo los fines de semana"
                        },
                        {
                            id: "d",
                            textEn: "Only if requested by the GM",
                            textEs: "Solo si lo pide el GM"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m10-q7",
                    questionEn: "A team member has full void/refund authority. True or false?",
                    questionEs: "Un miembro del equipo tiene autoridad completa de void/reembolso. ¿Verdadero o falso?",
                    options: [
                        {
                            id: "a",
                            textEn: "True — anyone with a Toast PIN can void",
                            textEs: "Verdadero — cualquier persona con PIN de Toast puede hacer void"
                        },
                        {
                            id: "b",
                            textEn: "False — only Shift Leads process voids, refunds, and comps",
                            textEs: "Falso — solo los Líderes procesan voids, reembolsos y comps"
                        },
                        {
                            id: "c",
                            textEn: "True if the manager is on break",
                            textEs: "Verdadero si el manager está en descanso"
                        },
                        {
                            id: "d",
                            textEn: "True for amounts under $5",
                            textEs: "Verdadero para cantidades menores a $5"
                        }
                    ],
                    correct: "b"
                }
            ]
        }
    },
    {
        id: "m11",
        code: "M11",
        track: "stations",
        tier: "all",
        icon: "🏃",
        durationMin: 15,
        titleEn: "Position: Food Runner",
        titleEs: "Estación: Food Runner",
        lessons: [
            {
                id: "m11-l1",
                titleEn: "What Food Runner Owns + Opening Setup",
                titleEs: "Lo Que Le Toca al Food Runner + Inicio de Turno",
                contentEn: [
                    "You take dine-in plates from Expo's window to the table. You also keep the dining room moving while you're at it — pre-bussing finished plates, wiping tables, refilling water and sauces, and checking on guests in their meal.",
                    "When you're not running food, you're in the dining room maintaining it. A clean, well-tended dining room is the difference between a good meal and a great one.",
                    "OPENING SETUP:",
                    "• Apron on. Wash hands. Then clock in — you clock in already in uniform and ready to work (see M2).",
                    "• Wipe down all dining room tables and chairs.",
                    "• Restock the condiment bar — hoisin, sriracha, sweet chili, peanut, soy, sambal, fish sauce.",
                    "• Restock the silverware caddy and napkin dispenser.",
                    "• Confirm the number tents are stacked at the register — the cashier hands one to every dine-in guest, and that number is how you find the table.",
                    "• Stock a pre-bus bin or bucket within reach so you can grab dirty plates fast.",
                    "• Confirm the 86'd list with the Shift Lead."
                ],
                contentEs: [
                    "Tú llevas los platos para comer aquí desde la ventana de Expo hasta la mesa. También mantienes el comedor en movimiento mientras tanto — retirando platos terminados (pre-bus), limpiando mesas, rellenando agua y salsas, y checando cómo van los clientes durante su comida.",
                    "Cuando no estás llevando comida, estás en el comedor manteniéndolo. Un comedor limpio y atendido es la diferencia entre una buena comida y una excelente.",
                    "INICIO DE TURNO:",
                    "• Ponte el delantal. Lávate las manos. Luego marca entrada — marcas entrada ya en uniforme y listo para trabajar (ver M2).",
                    "• Limpia todas las mesas y sillas del comedor.",
                    "• Surte el bar de condimentos — hoisin, sriracha, sweet chili, cacahuate, soya, sambal, salsa de pescado.",
                    "• Surte el caddy de cubiertos y el dispensador de servilletas.",
                    "• Confirma que los números de mesa estén apilados en la caja — el cajero le da uno a cada cliente que come aquí, y con ese número encuentras la mesa.",
                    "• Ten una cubeta o bin de pre-bus al alcance para agarrar platos sucios rápido.",
                    "• Confirma la lista de 86 con el líder."
                ]
            },
            {
                id: "m11-l2",
                titleEn: "Running Plates from Expo to the Table",
                titleEs: "Llevar Platos de Expo a la Mesa",
                contentEn: [
                    "When Expo calls a ticket, walk to the window, read the table number off the ticket, and glance that the plate matches the ticket — accuracy is everything. Pho cools in 90 seconds — pho goes first when there's a queue.",
                    "Carry plates with the table number facing you so you can confirm where it goes without having to stop and look again.",
                    "When you arrive at the table, call out the number and the dish: 'Number 14, your pho with brisket — enjoy! The herbs and lime are for you to customize.' Announce, don't ask — never 'who had the pho?' Don't just drop and walk.",
                    "Set the tray down squarely in front of the guest — bowl or plate centered, sauce cup and garnish plate beside it within easy reach. Two hands on every tray and bowl: pho is hot, heavy, and unforgiving. Neat placement tells the guest you care.",
                    "If a guest at the table asks for something while you're delivering, finish placing the plate, then say 'I'll grab that for you right now' — don't make them wait. Get it done before you walk back to expo.",
                    "Call out 'behind!' or 'corner!' when you're moving with hot plates."
                ],
                contentEs: [
                    "Cuando Expo anuncie un ticket, camina a la ventana, lee el número de mesa del ticket y revisa de un vistazo que el plato coincida con el ticket — la exactitud lo es todo. El pho se enfría en 90 segundos — el pho va primero cuando hay cola.",
                    "Carga los platos con el número de mesa hacia ti para confirmar a dónde van sin tener que parar y mirar otra vez.",
                    "Cuando llegues a la mesa, anuncia el número y el platillo: 'Número 14, su pho con pecho — ¡buen provecho! Las hierbas y el limón son para que lo ajuste a su gusto.' Anuncia, no preguntes — nunca '¿quién pidió el pho?'. No nada más lo dejes y te vayas.",
                    "Coloca la charola derecha frente al cliente — el tazón o plato al centro, el vasito de salsa y el plato de guarnición a un lado, al alcance. Dos manos en cada charola y tazón: el pho está caliente, pesado y no perdona. Una colocación ordenada le dice al cliente que te importa.",
                    "Si un cliente en la mesa te pide algo mientras llevas el plato, termina de colocarlo, luego di 'ahorita se lo traigo' — no lo hagas esperar. Hazlo antes de regresar a expo.",
                    "Grita '¡detrás!' o '¡esquina!' cuando te muevas con platos calientes."
                ]
            },
            {
                id: "m11-l3",
                titleEn: "Pre-Bussing, Refills & Reading the Room",
                titleEs: "Pre-Bus, Rellenos y Leer la Sala",
                contentEn: [
                    "PRE-BUS as you go. When you're walking back from delivering food, scan the dining room. Empty glass on a table? Grab it. Pile of finished plates? Grab them. Don't make a special trip — fold pre-bussing into every walk back to the line. Grab number tents off finished tables too and drop them back at the register.",
                    "TABLE WIPING — when a table clears out, wipe it down with a clean sani-rag from the sani bucket within 1 minute. A dirty empty table is the most visible sign that the dining room isn't being kept up.",
                    "WATER REFILLS — if you see a guest's water glass below a third full, top it off when you walk by. Don't ask, just do it.",
                    "SAUCE REFILLS — if a guest is dipping their last bite into an empty sauce cup, ask 'want me to grab you another?' before they have to ask.",
                    "READ THE ROOM — every time you walk through, scan all the tables. Eye contact with anyone who looks like they need something. A guest waving at you isn't a problem; a guest who shouldn't have HAD to wave is. Catch them before they wave.",
                    "THE 2-BITE CHECK — about 60–90 seconds after the food lands, swing back by: 'How's everything tasting? Is your pho just right?' This catches a wrong or cold plate early, while it's still easy to fix.",
                    "If a guest is unhappy or has a complaint, don't argue and don't blame the kitchen. Apologize sincerely — 'I'm really sorry about that, let me get our Shift Lead for you right now' — then find the Shift Lead immediately. The Lead owns the fix (remake, comp, RESTORE follow-through), not you. Never comp or refund on your own — Shift Lead only."
                ],
                contentEs: [
                    "PRE-BUS sobre la marcha. Cuando regreses de entregar comida, escanea el comedor. ¿Vaso vacío en una mesa? Agárralo. ¿Pila de platos terminados? Agárralos. No hagas un viaje especial — incluye el pre-bus en cada caminada de regreso a la línea. Recoge también los números de mesa de las mesas que ya terminaron y regrésalos a la caja.",
                    "LIMPIEZA DE MESAS — cuando una mesa se desocupe, límpiala con un trapo limpio de la cubeta de desinfectante en menos de 1 minuto. Una mesa vacía sucia es la señal más visible de que el comedor no se está atendiendo.",
                    "RELLENO DE AGUA — si ves el vaso de agua de un cliente abajo de un tercio, llénalo al pasar. No preguntes, solo hazlo.",
                    "RELLENO DE SALSA — si ves a un cliente mojar su último bocado en un vasito ya vacío, pregunta '¿le traigo otro?' antes de que tenga que pedirlo.",
                    "LEE LA SALA — cada vez que camines por el comedor, escanea todas las mesas. Contacto visual con cualquiera que parezca necesitar algo. Un cliente que te hace señas no es problema; un cliente que NO debió haber tenido que hacer señas sí lo es. Anticípate antes de que tenga que hacer señas.",
                    "EL CHEQUEO A LOS 2 BOCADOS — unos 60–90 segundos después de que llega la comida, pasa otra vez: '¿Qué tal todo? ¿Está bien su pho?' Así atrapas un plato equivocado o frío a tiempo, cuando todavía es fácil arreglarlo.",
                    "Si un cliente está molesto o tiene una queja, no discutas y no culpes a la cocina. Discúlpate con sinceridad — 'Lo siento mucho, ahorita le traigo al líder de turno' — y busca al líder inmediatamente. El líder es quien resuelve (rehacer, comp, seguimiento RESTORE), no tú. Nunca hagas comp ni reembolso por tu cuenta — solo el líder."
                ]
            },
            {
                id: "m11-l4",
                titleEn: "Hand-Off Double-Check + Closing",
                titleEs: "Doble Revisión + Cierre",
                contentEn: [
                    "When you also help hand out to-go orders at the counter, READ THE TICKET on the bag before handing it over. The bagger marked it: dessert, drink (round sticker), call-in (circled), multi-bag (1 OF 2). YOUR job is to confirm:",
                    "• If 'DESSERT IN BAG' is written, peek in to confirm the dessert is there.",
                    "• If a round sticker is on the ticket, walk to the Drinks station and grab the drink before handing the bag over.",
                    "• If CALL IN is circled, take payment from the guest before handing the bag over.",
                    "• If 'BAG 1 OF 2' is written, grab BOTH bags before walking to the counter.",
                    "• Confirm the customer's name on the ticket out loud: 'Order for Andrew?'",
                    "Hand the bag over with a smile and 'thanks for coming in.' That's the last interaction the guest has with us — make it count.",
                    "CLOSING — the wall checklist at your store is the source of truth; this is the quick reference:",
                    "• Wipe down all tables and chairs.",
                    "• Restock the condiment bar.",
                    "• Restock silverware and napkins.",
                    "• Bring all dirty plates and bus tubs to the dish pit.",
                    "• Sweep and mop the dining room floor.",
                    "• Collect any number tents left in the dining room and return them to the register stack."
                ],
                contentEs: [
                    "Cuando también ayudas a entregar órdenes para llevar en el mostrador, LEE EL TICKET en la bolsa antes de entregarla. El bagger lo marcó: postre, bebida (calcomanía redonda), call-in (circulado), varias bolsas (1 OF 2). TU trabajo es confirmar:",
                    "• Si dice 'DESSERT IN BAG,' asómate adentro para confirmar que el postre esté.",
                    "• Si hay calcomanía redonda en el ticket, camina a la estación de Drinks y agarra la bebida antes de entregar la bolsa.",
                    "• Si CALL IN está circulado, cobra al cliente antes de entregar la bolsa.",
                    "• Si dice 'BAG 1 OF 2,' agarra LAS DOS bolsas antes de caminar al mostrador.",
                    "• Confirma el nombre del cliente en el ticket en voz alta: '¿Orden para Andrew?'",
                    "Entrega la bolsa con una sonrisa y un 'gracias por venir.' Esa es la última interacción que el cliente tiene con nosotros — hazla valer.",
                    "CIERRE — el checklist de la pared de tu tienda es la fuente verdadera; esto es la referencia rápida:",
                    "• Limpia todas las mesas y sillas.",
                    "• Surte el bar de condimentos.",
                    "• Surte cubiertos y servilletas.",
                    "• Lleva todos los platos sucios y bus tubs al área de lavado.",
                    "• Barre y mopea el piso del comedor.",
                    "• Recoge los números de mesa que queden en el comedor y regrésalos a la pila de la caja."
                ]
            }
        ],
        quiz: {
            passThreshold: 0.8,
            questions: [
                {
                    id: "m11-q1",
                    questionEn: "Pho cools in 90 seconds. When there's a queue at the expo window, pho:",
                    questionEs: "El pho se enfría en 90 segundos. Cuando hay cola en la ventana de expo, el pho:",
                    options: [
                        {
                            id: "a",
                            textEn: "Goes last so other plates don't get cold",
                            textEs: "Va al último para que los otros platos no se enfríen"
                        },
                        {
                            id: "b",
                            textEn: "Goes first",
                            textEs: "Va primero"
                        },
                        {
                            id: "c",
                            textEn: "Doesn't matter — order doesn't affect temperature",
                            textEs: "No importa — el orden no afecta la temperatura"
                        },
                        {
                            id: "d",
                            textEn: "Stays under the heat lamp",
                            textEs: "Se queda bajo la lámpara de calor"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m11-q2",
                    questionEn: "When delivering a plate to a table, you should:",
                    questionEs: "Al entregar un plato en una mesa, debes:",
                    options: [
                        {
                            id: "a",
                            textEn: "Drop it silently and walk away fast",
                            textEs: "Dejarlo en silencio y caminar rápido"
                        },
                        {
                            id: "b",
                            textEn: "Call the table number and the dish: 'Number 14, your pho with brisket — enjoy!'",
                            textEs: "Anunciar el número y el platillo: 'Número 14, su pho con pecho — buen provecho.'"
                        },
                        {
                            id: "c",
                            textEn: "Ask the guest to confirm what they ordered",
                            textEs: "Pedir al cliente que confirme qué ordenó"
                        },
                        {
                            id: "d",
                            textEn: "Just say 'enjoy' and move on",
                            textEs: "Solo decir 'buen provecho' y seguir"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m11-q3",
                    questionEn: "An empty table just cleared. How fast should you wipe it down?",
                    questionEs: "Una mesa se acaba de desocupar. ¿Qué tan rápido debes limpiarla?",
                    options: [
                        {
                            id: "a",
                            textEn: "When you have time",
                            textEs: "Cuando tengas tiempo"
                        },
                        {
                            id: "b",
                            textEn: "Within 1 minute — a dirty empty table is the most visible sign of a neglected dining room",
                            textEs: "En menos de 1 minuto — una mesa vacía sucia es la señal más visible de un comedor desatendido"
                        },
                        {
                            id: "c",
                            textEn: "Only at the end of the rush",
                            textEs: "Solo al final del rush"
                        },
                        {
                            id: "d",
                            textEn: "Only if a guest is waiting for it",
                            textEs: "Solo si un cliente está esperando"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m11-q4",
                    questionEn: "You're handing out a to-go bag and see a round sticker on the ticket. You:",
                    questionEs: "Estás entregando una bolsa para llevar y ves una calcomanía redonda en el ticket. Tú:",
                    options: [
                        {
                            id: "a",
                            textEn: "Hand the bag over — sticker is just decoration",
                            textEs: "Entregas la bolsa — la calcomanía es decoración"
                        },
                        {
                            id: "b",
                            textEn: "Walk to the Drinks station and grab the drink before handing over the bag",
                            textEs: "Caminas a la estación de Drinks y agarras la bebida antes de entregar la bolsa"
                        },
                        {
                            id: "c",
                            textEn: "Ask the guest if they ordered a drink",
                            textEs: "Le preguntas al cliente si pidió bebida"
                        },
                        {
                            id: "d",
                            textEn: "Take payment",
                            textEs: "Cobras"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m11-q5",
                    questionEn: "CALL IN is circled on the ticket. You:",
                    questionEs: "CALL IN está circulado en el ticket. Tú:",
                    options: [
                        {
                            id: "a",
                            textEn: "Hand the bag over normally",
                            textEs: "Entregas la bolsa normalmente"
                        },
                        {
                            id: "b",
                            textEn: "Take payment from the guest before handing the bag over",
                            textEs: "Cobras al cliente antes de entregar la bolsa"
                        },
                        {
                            id: "c",
                            textEn: "Bring it back to the kitchen",
                            textEs: "Lo llevas de regreso a la cocina"
                        },
                        {
                            id: "d",
                            textEn: "Ask the cashier",
                            textEs: "Le preguntas al cajero"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m11-q6",
                    questionEn: "A guest at a table is unhappy with their meal. You:",
                    questionEs: "Un cliente en una mesa está molesto con su comida. Tú:",
                    options: [
                        {
                            id: "a",
                            textEn: "Comp the meal yourself",
                            textEs: "Haces un comp de la comida tú solo"
                        },
                        {
                            id: "b",
                            textEn: "Handle it entirely yourself and never tell the Lead",
                            textEs: "Lo manejas todo tú solo y nunca le avisas al líder"
                        },
                        {
                            id: "c",
                            textEn: "Apologize, then find the Shift Lead immediately — the Lead owns the fix, not you",
                            textEs: "Te disculpas y buscas al líder inmediatamente — el líder resuelve, no tú"
                        },
                        {
                            id: "d",
                            textEn: "Tell them to ask the cashier for a refund",
                            textEs: "Les dices que pidan reembolso al cajero"
                        }
                    ],
                    correct: "c"
                }
            ]
        }
    },
    {
        id: "m12",
        code: "M12",
        track: "stations",
        tier: "all",
        icon: "🪑",
        durationMin: 10,
        titleEn: "Position: Dining Room (Busy-Day Support)",
        titleEs: "Estación: Comedor (Apoyo en Días Ocupados)",
        lessons: [
            {
                id: "m12-l1",
                titleEn: "What Dining Room Owns",
                titleEs: "Lo Que Le Toca al Comedor",
                contentEn: [
                    "Dining Room is a busy-day-only role. On heavy lunches, dinner rushes, and weekend volume, we add a dedicated person whose only job is to keep the dining room clean and the tables ready.",
                    "You don't run food, build orders, or work the register (only exception: when the food runner calls for hands on a multi-plate table). You walk the dining room.",
                    "What you do, all shift:",
                    "• Pre-bus tables — grab finished plates, glasses, sauce cups, trash before guests have to ask.",
                    "• Wipe tables down within 1 minute of guests leaving — with a rag from the sani bucket (never a dry or dirty rag). The rag goes back IN the bucket between tables.",
                    "• Reset tables — collect the number tent and return it to the register stack, clean napkin holder, condiments aligned, chairs pushed in.",
                    "• Refill water glasses anywhere you see one below a third full.",
                    "• Restock the condiment bar continuously — hoisin, sriracha, sweet chili, peanut sauce, soy, sambal, fish sauce — plus sauce cups and napkins.",
                    "• Empty bus tubs to the dish pit before they overflow.",
                    "• Help the food runner with multi-plate dine-in deliveries when they call for help.",
                    "FOOD SAFETY: bussing means dirty dishes and trash. Wash your hands (20 seconds, soap + hot water) after emptying a bus tub or handling trash and BEFORE you refill water, restock the condiment bar, or help run a plate. Sanitizer is not a substitute.",
                    "On a non-busy day, this position folds back into the Food Runner — same person does both."
                ],
                contentEs: [
                    "Comedor es un rol solo para días ocupados. En almuerzos pesados, rushes de cena, y volumen de fin de semana, agregamos una persona dedicada cuyo único trabajo es mantener el comedor limpio y las mesas listas.",
                    "No llevas comida, no armas órdenes, no trabajas la caja (única excepción: cuando el food runner pide manos para una mesa de varios platos). Caminas el comedor.",
                    "Lo que haces, todo el turno:",
                    "• Pre-bus mesas — agarra platos terminados, vasos, vasitos de salsa, basura antes de que el cliente tenga que pedir.",
                    "• Limpia mesas en menos de 1 minuto de que el cliente se vaya — con un trapo de la cubeta de desinfectante (nunca un trapo seco o sucio). El trapo regresa A la cubeta entre mesa y mesa.",
                    "• Resetea mesas — recoge el número de mesa y regrésalo a la pila de la caja, servilletero limpio, condimentos alineados, sillas acomodadas.",
                    "• Rellena vasos de agua donde sea que veas uno abajo de un tercio.",
                    "• Surte el bar de condimentos continuamente — hoisin, sriracha, sweet chili, salsa de cacahuate, soya, sambal, salsa de pescado — más vasitos de salsa y servilletas.",
                    "• Vacía los bus tubs al área de lavado antes de que se desborden.",
                    "• Ayuda al food runner con entregas de varios platos cuando pida apoyo.",
                    "SEGURIDAD ALIMENTARIA: hacer pre-bus significa platos sucios y basura. Lávate las manos (20 segundos, jabón y agua caliente) después de vaciar un bus tub o tocar basura y ANTES de rellenar agua, surtir el bar de condimentos o ayudar a llevar un plato. El sanitizante no sustituye el lavado.",
                    "En un día tranquilo, esta posición se combina con Food Runner — la misma persona hace las dos."
                ]
            },
            {
                id: "m12-l2",
                titleEn: "Reading the Room + Common Mistakes",
                titleEs: "Leer la Sala + Errores Comunes",
                contentEn: [
                    "READ THE ROOM. Every loop through the dining room, you scan ALL tables. Catch:",
                    "• Empty glasses (refill water).",
                    "• Finished plates (pre-bus).",
                    "• Tables that just cleared (wipe + reset).",
                    "• Trash on a table (clear it).",
                    "• A guest looking around (eye contact, ask if they need anything).",
                    "Move continuously. A Dining Room person standing in one spot is missing tables. The good Dining Room person almost looks like they're walking laps.",
                    "If you spot something the kitchen or Lead needs to know — a broken chair, a big spill, a complaint — flag the Shift Lead. Complaint: don't walk off in silence — acknowledge the guest first (\"I'm so sorry — let me grab the Shift Lead for you right now\"), then go get the Lead. Never promise a comp, refund, or free item yourself — that call is the Shift Lead's. Spill on the floor: it's a slip hazard — clean it up right away, then tell the Lead. Anything that isn't a wipe-and-restock job goes to the Lead.",
                    "COMMON MISTAKES:",
                    "• Standing in one corner instead of walking the room.",
                    "• Wiping tables only when guests are waiting for them — the goal is to NEVER let a guest wait for a table.",
                    "• Refilling water only when guests ask — the goal is to refill before they ask.",
                    "• Leaving number tents on cleared tables — collect them and get them back to the register, or the cashier runs out.",
                    "• Letting bus tubs overflow.",
                    "• Trying to handle a guest complaint solo — that's the Shift Lead's job."
                ],
                contentEs: [
                    "LEE LA SALA. Cada vuelta por el comedor, escaneas TODAS las mesas. Fíjate en:",
                    "• Vasos vacíos (rellena agua).",
                    "• Platos terminados (pre-bus).",
                    "• Mesas que se acaban de desocupar (limpia + resetea).",
                    "• Basura en la mesa (recógela).",
                    "• Un cliente mirando a su alrededor (contacto visual, pregunta si necesita algo).",
                    "Muévete continuamente. A una persona de Comedor parada en un solo lugar se le pasan mesas. La persona buena de Comedor casi parece que está dando vueltas.",
                    "Si ves algo que la cocina o el líder necesite saber — una silla rota, un derrame grande, una queja — avísale al líder de turno. Queja: no te vayas sin decir nada — primero reconoce al cliente (\"Una disculpa — ahorita le traigo al líder de turno\"), y luego ve por el líder. Nunca prometas un comp, reembolso ni nada gratis tú — esa decisión es del líder. Derrame en el piso: es riesgo de resbalón — límpialo de inmediato y luego avísale al líder. Todo lo que no sea trabajo de limpiar y surtir va con el líder.",
                    "ERRORES COMUNES:",
                    "• Quedarte parado en una esquina en lugar de caminar la sala.",
                    "• Limpiar mesas solo cuando hay clientes esperando — la meta es que NUNCA tenga que esperar un cliente por una mesa.",
                    "• Rellenar agua solo cuando el cliente pide — la meta es rellenar antes de que pida.",
                    "• Dejar los números de mesa en las mesas desocupadas — recógelos y regrésalos a la caja, o al cajero se le acaban.",
                    "• Dejar que los bus tubs se desborden.",
                    "• Intentar manejar una queja de cliente solo — eso es trabajo del líder."
                ]
            }
        ],
        quiz: {
            passThreshold: 0.8,
            questions: [
                {
                    id: "m12-q1",
                    questionEn: "Dining Room is which kind of role?",
                    questionEs: "¿Qué tipo de rol es Comedor?",
                    options: [
                        {
                            id: "a",
                            textEn: "A position you work every shift",
                            textEs: "Una posición que trabajas cada turno"
                        },
                        {
                            id: "b",
                            textEn: "A busy-day-only role focused on table cleaning, pre-bussing, refills, and resets",
                            textEs: "Un rol solo para días ocupados enfocado en limpiar mesas, pre-bus, rellenos y resets"
                        },
                        {
                            id: "c",
                            textEn: "A role that builds drinks",
                            textEs: "Un rol que arma bebidas"
                        },
                        {
                            id: "d",
                            textEn: "A leadership role",
                            textEs: "Un rol de liderazgo"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m12-q2",
                    questionEn: "When should you wipe a table down after guests leave?",
                    questionEs: "¿Cuándo debes limpiar una mesa después de que se vayan los clientes?",
                    options: [
                        {
                            id: "a",
                            textEn: "Only when another guest is waiting",
                            textEs: "Solo cuando otro cliente esté esperando"
                        },
                        {
                            id: "b",
                            textEn: "At the end of the shift",
                            textEs: "Al final del turno"
                        },
                        {
                            id: "c",
                            textEn: "Within 1 minute — the goal is to NEVER make a guest wait for a clean table",
                            textEs: "En menos de 1 minuto — la meta es que NUNCA un cliente espere por una mesa limpia"
                        },
                        {
                            id: "d",
                            textEn: "When the Shift Lead asks",
                            textEs: "Cuando el líder lo pida"
                        }
                    ],
                    correct: "c"
                },
                {
                    id: "m12-q3",
                    questionEn: "A guest's water glass is below a third full. You:",
                    questionEs: "El vaso de agua de un cliente está abajo de un tercio. Tú:",
                    options: [
                        {
                            id: "a",
                            textEn: "Wait until they ask",
                            textEs: "Esperas a que pidan"
                        },
                        {
                            id: "b",
                            textEn: "Top it off when you walk by — don't ask, just do it",
                            textEs: "Lo rellenas al pasar — no preguntes, solo hazlo"
                        },
                        {
                            id: "c",
                            textEn: "Bring a pitcher and let them serve themselves",
                            textEs: "Trae una jarra y deja que se sirvan"
                        },
                        {
                            id: "d",
                            textEn: "Ignore — it's not empty yet",
                            textEs: "Ignóralo — aún no está vacío"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m12-q4",
                    questionEn: "You spot a guest with a complaint at table 7. You:",
                    questionEs: "Ves a un cliente con una queja en la mesa 7. Tú:",
                    options: [
                        {
                            id: "a",
                            textEn: "Try to fix it yourself",
                            textEs: "Intentas arreglarlo tú solo"
                        },
                        {
                            id: "b",
                            textEn: "Comp the meal",
                            textEs: "Le regalas la comida (comp)"
                        },
                        {
                            id: "c",
                            textEn: "Acknowledge the guest, then find the Shift Lead immediately",
                            textEs: "Reconoces al cliente y enseguida buscas al líder de turno"
                        },
                        {
                            id: "d",
                            textEn: "Walk away and pretend you didn't see it",
                            textEs: "Te vas y finges que no lo viste"
                        }
                    ],
                    correct: "c"
                },
                {
                    id: "m12-q5",
                    questionEn: "The best Dining Room person looks like they're:",
                    questionEs: "La mejor persona de Comedor parece que está:",
                    options: [
                        {
                            id: "a",
                            textEn: "Standing still and watching",
                            textEs: "Parada y observando"
                        },
                        {
                            id: "b",
                            textEn: "Walking laps continuously, scanning every table",
                            textEs: "Dando vueltas continuamente, escaneando cada mesa"
                        },
                        {
                            id: "c",
                            textEn: "Talking to other staff",
                            textEs: "Hablando con otro staff"
                        },
                        {
                            id: "d",
                            textEn: "Hanging out at the register",
                            textEs: "En la caja"
                        }
                    ],
                    correct: "b"
                }
            ]
        }
    },
    {
        id: "m17",
        code: "M17",
        track: "new-hire",
        tier: "all",
        icon: "🛑",
        durationMin: 30,
        titleEn: "Allergen Matrix",
        titleEs: "Matriz de Alérgenos",
        lessons: [
            {
                id: "m17-l1",
                titleEn: "Big 9 + DD Mau Critical Facts",
                titleEs: "9 Grandes + Datos Críticos de DD Mau",
                contentEn: [
                    "The 9 Major Food Allergens: Milk, Eggs, Fish, Shellfish, Tree Nuts, Peanuts, Wheat, Soy, Sesame. We track all 9 plus MSG sensitivity (technically not an allergen, but guests ask about it constantly).",
                    "STOP — if a guest has an allergy, get the Shift Lead. Profile = BASE + PROTEIN + SAUCE. You cannot answer an allergy question correctly without knowing all three pieces.",
                    "DD Mau-specific facts you MUST know cold:",
                    "• Our oyster sauce IS gluten-free. Many oyster sauces aren't — ours is. This matters for anything that uses oyster sauce in the marinade or the lo mein sauce.",
                    "• Fish sauce contains FISH. It is in the Vietnamese Vinaigrette and the lemongrass meat marinade — both of which also add ⚠ MSG.",
                    "• Our HOUSE hoisin contains PEANUT (we add peanut butter), plus SOY and WHEAT from the base hoisin. It is in our Hoisin sauce and Peanut Dressing. The Vegan Beef marinade also uses hoisin — until the kitchen confirms which hoisin, treat Vegan Beef as a possible PEANUT allergen (it is definitely soy + wheat).",
                    "• Vegan Cream Cheese is made from ALMOND. Tree nut allergen.",
                    "• Vegetarian fish sauce is SOY-based. Used in the Vegan Vietnamese Vinaigrette.",
                    "• Crushed peanuts go on Vermicelli Bowls and Salad Bowls by default. Always ask about peanut allergies — and even then, omit them if a guest looks unsure.",
                    "• Lemongrass-marinated chicken, pork and beef contain FISH (fish sauce), SOY (oyster sauce) and SESAME — sesame allergy = ask about EVERY marinated protein. Lemongrass SHRIMP is marinated differently: lemongrass + garlic + SESAME OIL (shellfish + sesame). The recipe book shows no fish sauce in the shrimp marinade, but until the kitchen confirms, treat shrimp as fish/soy too — never tell a fish-allergic guest the shrimp is safe.",
                    "• Our boba milk tea creamer is labeled 'Non-Dairy' but contains SODIUM CASEINATE + LACTOSE + MILK FLAVOR. It IS a milk allergen. The 'non-dairy' label means no butterfat — it does NOT mean milk-allergy-safe. The creamer is pre-mixed into the milk-tea powder base, so there is NO safe substitute for a boba milk tea — 'sub oat milk' does NOT fix it. Milk allergy = redirect to a FRUIT TEA. (Matcha Latte, Masala Chai and Thai Tea are different: real milk is added per drink, so oat or soy milk IS a safe sub there. Almond milk = tree nut allergen.)",
                    "When in doubt: GET THE SHIFT LEAD. Allergen calls belong to the Shift Lead — that's by design, so you never have to guess alone."
                ],
                contentEs: [
                    "Los 9 Alérgenos Alimentarios Mayores: Leche, Huevos, Pescado, Mariscos, Frutos Secos, Cacahuates, Trigo, Soya, Ajonjolí. Controlamos los 9 y también la sensibilidad al MSG (técnicamente no es alergia, pero los clientes preguntan todo el tiempo).",
                    "PARA — si un cliente tiene una alergia, avisa al líder de turno (Shift Lead). Perfil = BASE + PROTEÍNA + SALSA. No puedes responder una pregunta de alergia correctamente sin saber las tres piezas.",
                    "Datos específicos de DD Mau que DEBES saber al pie de la letra:",
                    "• Nuestra salsa de ostión ES sin gluten. Muchas salsas de ostión no lo son — la nuestra sí. Esto importa para cualquier cosa con salsa de ostión en marinado o salsa lo mein.",
                    "• La salsa de pescado contiene PESCADO. Va en la Vinagreta Vietnamita y en el marinado de carne con hierba limón — y a los dos también se les agrega ⚠ MSG.",
                    "• Nuestro hoisin de la CASA contiene CACAHUATE (le agregamos crema de cacahuate), más SOYA y TRIGO del hoisin base. Va en nuestra salsa Hoisin y en el Peanut Dressing. El marinado de la carne vegana también lleva hoisin — hasta que cocina confirme cuál hoisin, trata la Carne Vegana como posible alérgeno de CACAHUATE (seguro lleva soya + trigo).",
                    "• El Queso Crema Vegano se hace de ALMENDRA. Alérgeno de fruto seco.",
                    "• La salsa de pescado vegetariana es a base de SOYA. Se usa en la Vinagreta Vietnamita Vegana.",
                    "• Los cacahuates molidos van encima de Vermicelli Bowls y Salad Bowls por defecto. Siempre pregunta por alergia al cacahuate — y aún así, omítelos si el cliente se ve dudoso.",
                    "• El pollo, cerdo y res marinados con hierba limón contienen PESCADO (salsa de pescado), SOYA (salsa de ostión) y AJONJOLÍ — alergia al ajonjolí = pregunta por CADA proteína marinada. El CAMARÓN con hierba limón se marina distinto: hierba limón + ajo + ACEITE DE AJONJOLÍ (marisco + ajonjolí). El recetario no muestra salsa de pescado en el marinado del camarón, pero hasta que cocina lo confirme, trátalo también como pescado/soya — nunca le digas a un alérgico al pescado que el camarón es seguro.",
                    "• La crema de nuestros boba milk teas dice 'Non-Dairy' pero contiene CASEINATO DE SODIO + LACTOSA + SABOR DE LECHE. SÍ es un alérgeno de leche. La etiqueta 'non-dairy' significa sin grasa láctea — NO significa segura para alergia a la leche. La crema ya viene mezclada en la base en polvo del milk tea, así que NO hay sustituto seguro para un boba milk tea — 'cámbiame a leche de avena' NO lo arregla. Alergia a la leche = redirige a un FRUIT TEA. (Matcha Latte, Masala Chai y Thai Tea son diferentes: la leche se agrega por bebida, así que ahí la leche de avena o de soya SÍ es un sustituto seguro. Leche de almendra = alérgeno de fruto seco.)",
                    "Cuando dudes: AVISA AL LÍDER DE TURNO. Las decisiones de alergias le tocan al líder de turno — así está diseñado, para que nunca tengas que adivinar solo."
                ]
            },
            {
                id: "m17-l2",
                titleEn: "Reading the Matrix — BASE + PROTEIN + SAUCE",
                titleEs: "Leer la Matriz — BASE + PROTEÍNA + SALSA",
                contentEn: [
                    "The Allergen Matrix is split into four sections. To answer any allergy question correctly, you walk through the matrix in this order:",
                    "1. The BASE — the bowl, sandwich, taco, or pho broth itself (without protein and without sauce). Vermicelli Bowl, Salad Bowl, Rice Bowl, Bao Sliders, Spring Rolls, Banh Mi, Tacos, Fried Rice, the Pho broths (regular + vegan), Lo Mein.",
                    "2. The PROTEIN — chicken, pork, steak/beef, shrimp, combo, fried fish, coconut shrimp (TREE NUT + shellfish + wheat + egg + soy), Cajun salmon (fish), tofu, vegan beef, vegan shrimp, vegan chikn, veggie, plus pho-specific proteins (brisket, rare steak, beef meatball, chicken, seafood, spicy vegan lemongrass).",
                    "3. The SAUCE — Vietnamese Vinaigrette, Vegan Vinaigrette, Sweet Chili, Peanut Dressing, Spicy Peanut, DD Dressing, Spicy DD, Hoisin (DD Mau house).",
                    "4. SNACKS & SIDES are self-contained — Crab Rangoons, Wings, Fried Shrimp Rolls, Vegan Cheese Rolls, Veggie Egg Rolls, Vietnamese Egg Rolls. You do not stack base + protein + sauce on these — they are what they are.",
                    "Worked example. Guest orders Vermicelli Bowl, chicken, peanut dressing.",
                    "• BASE (Vermicelli Bowl): contains PEANUT (crushed peanut topping), WHEAT/GLUTEN + EGG + SOY (the default Vietnamese egg roll), MSG, ⚠ FISH + SESAME possible (fish sauce + sesame oil in that egg roll — remove the egg roll and they drop out).",
                    "• PROTEIN (chicken lemongrass): adds FISH (fish sauce), SOY (oyster sauce), SESAME, MSG.",
                    "• SAUCE (Peanut Dressing): adds PEANUT (already there), SOY, WHEAT/GLUTEN.",
                    "Combined profile: PEANUT + WHEAT + SOY + EGG + FISH + SESAME + MSG. If a guest tells you any of those, you have to redirect them."
                ],
                contentEs: [
                    "La Matriz de Alérgenos está dividida en cuatro secciones. Para responder cualquier pregunta de alergia correctamente, recorres la matriz en este orden:",
                    "1. La BASE — el bowl, sándwich, taco o caldo de pho mismo (sin proteína y sin salsa). Vermicelli Bowl, Salad Bowl, Rice Bowl, Bao Sliders, Spring Rolls, Banh Mi, Tacos, Arroz Frito, los caldos de Pho (regular + vegano), Lo Mein.",
                    "2. La PROTEÍNA — pollo, cerdo, res, camarón, combo, pescado frito, camarón con coco (FRUTO SECO + marisco + trigo + huevo + soya), salmón cajún (pescado), tofu, carne vegana, camarón vegano, pollo vegano, verduras, más las proteínas de pho (pecho, bistec poco cocido, albóndiga, pollo, mariscos, vegano picante con hierba limón).",
                    "3. La SALSA — Vinagreta Vietnamita, Vinagreta Vegana, Sweet Chili, Peanut Dressing, Spicy Peanut, DD Dressing, Spicy DD, Hoisin (estilo DD Mau).",
                    "4. SNACKS Y ACOMPAÑAMIENTOS ya vienen completos — Crab Rangoons, Wings, Rollos de Camarón Frito, Rollos de Queso Vegano, Veggie Egg Rolls, Egg Rolls Vietnamitas. No sumas base + proteína + salsa en estos — son lo que son.",
                    "Ejemplo práctico. El cliente pide Vermicelli Bowl, pollo, peanut dressing.",
                    "• BASE (Vermicelli Bowl): contiene CACAHUATE (cacahuate molido encima), TRIGO/GLUTEN + HUEVO + SOYA (el egg roll vietnamita por defecto), MSG, ⚠ PESCADO + AJONJOLÍ posibles (salsa de pescado + aceite de ajonjolí en ese egg roll — sin egg roll, desaparecen).",
                    "• PROTEÍNA (pollo con hierba limón): agrega PESCADO (salsa de pescado), SOYA (salsa de ostión), AJONJOLÍ, MSG.",
                    "• SALSA (Peanut Dressing): agrega CACAHUATE (ya estaba), SOYA, TRIGO/GLUTEN.",
                    "Perfil combinado: CACAHUATE + TRIGO + SOYA + HUEVO + PESCADO + AJONJOLÍ + MSG. Si un cliente te dice cualquiera de esos, tienes que redirigirlo."
                ]
            },
            {
                id: "m17-l3",
                titleEn: "Allergen Matrix — Entrees, Proteins & Snacks",
                titleEs: "Matriz de Alérgenos — Entrees, Proteínas y Snacks",
                contentEn: [
                    "This is the official chart. Scroll right to see all allergen columns. ● = contains. ◐ = may contain or depends on choice. Blank = does not typically contain. ✓ = vegan-friendly. ✓* = can be made vegan.",
                    "When in doubt — get the Shift Lead. Cross-contact is always possible in a shared kitchen."
                ],
                contentEs: [
                    "Esta es la tabla oficial. Desliza a la derecha para ver todas las columnas. ● = contiene. ◐ = puede contener o depende de la elección. En blanco = no contiene típicamente. ✓ = apto vegano. ✓* = se puede hacer vegano.",
                    "En duda — llama al líder. El contacto cruzado siempre es posible en una cocina compartida."
                ],
                matrix: {
                    sections: [
                        {
                            titleEn: "ENTREES",
                            titleEs: "PLATOS PRINCIPALES",
                            rows: [
                                {
                                    itemEn: "Vermicelli Bowl",
                                    itemEs: "Vermicelli Bowl",
                                    v: {
                                        eggs: "●",
                                        fish: "◐",
                                        shell: "◐",
                                        peanut: "●",
                                        wheat: "●",
                                        soy: "●",
                                        sesame: "◐",
                                        msg: "●"
                                    },
                                    vegan: "✓*",
                                    notesEn: "Comes WITH an egg roll (wheat + egg) and crushed peanuts BY DEFAULT — both can be removed. Wheat/egg allergy = NO egg roll. Peanut allergy = NO peanuts. Vegan = NO egg roll (the veggie egg roll has an egg wrapper) + vegan protein + vegan sauce. Vinaigrette has fish sauce (sub Vegan Vinaigrette). Soy/fish/sesame come from the default egg roll + your protein/sauce — no egg roll + Veggie protein + Vinaigrette, Sweet Chili or DD = soy-free. Gluten-free only with a matching protein + sauce (tofu and vegan proteins are marinated in soy sauce = WHEAT).",
                                    notesEs: "Viene CON egg roll (trigo + huevo) y cacahuate molido POR DEFECTO — los dos se pueden quitar. Alergia a trigo/huevo = SIN egg roll. Alergia a cacahuate = SIN cacahuate. Vegano = SIN egg roll (el veggie egg roll lleva envoltura con huevo) + proteína vegana + salsa vegana. La vinagreta lleva salsa de pescado (sustituye por la Vegana). La soya/pescado/ajonjolí vienen del egg roll por defecto + tu proteína/salsa — sin egg roll + proteína de verduras + Vinagreta, Sweet Chili o DD = sin soya. Sin gluten solo con proteína y salsa adecuadas (el tofu y las proteínas veganas se marinan en salsa de soya = TRIGO)."
                                },
                                {
                                    itemEn: "Salad Bowl",
                                    itemEs: "Salad Bowl",
                                    v: {
                                        eggs: "●",
                                        fish: "◐",
                                        shell: "◐",
                                        peanut: "●",
                                        wheat: "●",
                                        soy: "●",
                                        sesame: "◐",
                                        msg: "●"
                                    },
                                    vegan: "✓*",
                                    notesEn: "Same as Vermicelli Bowl (egg roll + peanuts by default, both removable; vegan = no egg roll; soy/fish/sesame come from the egg roll + your protein/sauce), spring mix instead of noodles.",
                                    notesEs: "Igual que el Vermicelli Bowl (egg roll + cacahuate por defecto, ambos se pueden quitar; vegano = sin egg roll; la soya/pescado/ajonjolí vienen del egg roll + tu proteína/salsa), mezcla de hojas en vez de fideos."
                                },
                                {
                                    itemEn: "Rice Bowl",
                                    itemEs: "Rice Bowl",
                                    v: {
                                        eggs: "●",
                                        fish: "◐",
                                        shell: "◐",
                                        peanut: "◐",
                                        wheat: "◐",
                                        soy: "◐"
                                    },
                                    vegan: "✓*",
                                    notesEn: "Default has over-easy egg — request 'no egg' for vegan. No peanuts by default (optional). GLUTEN-FREE ONLY with a gluten-free protein + gluten-free sauce: lemongrass chicken/steak/shrimp and veggie are GF (our oyster sauce is GF); tofu and vegan beef/shrimp/chikn are marinated in soy sauce or hoisin = WHEAT; roast pork is dipped in soy sauce and fried fish is coated — ask the kitchen before calling either GF. Vegan + gluten-free = Veggie protein only. Soy depends on protein + sauce.",
                                    notesEs: "Por defecto lleva huevo estrellado — pide 'sin huevo' para vegano. Sin cacahuate por defecto (opcional). SIN GLUTEN SOLO con proteína sin gluten + salsa sin gluten: pollo/res/camarón con hierba limón y verduras son sin gluten (nuestra salsa de ostión es sin gluten); el tofu y la carne/camarón/pollo veganos se marinan en soya u hoisin = TRIGO; el cerdo asado se baña en soya y el pescado frito lleva empanizado — pregunta a cocina antes de decir que son sin gluten. Vegano + sin gluten = solo proteína de verduras. La soya depende de la proteína + salsa."
                                },
                                {
                                    itemEn: "Pho (regular)",
                                    itemEs: "Pho (regular)",
                                    v: {
                                        fish: "●",
                                        shell: "◐",
                                        soy: "●",
                                        msg: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "GLUTEN-FREE. Broth uses fish sauce. Shellfish only if combo/shrimp/seafood. Regular size only — NO large pho.",
                                    notesEs: "SIN GLUTEN. Caldo lleva salsa de pescado. Mariscos sólo en combo/camarón/seafood. Sólo tamaño regular."
                                },
                                {
                                    itemEn: "Pho *VEGAN",
                                    itemEs: "Pho *VEGANO",
                                    v: {
                                        soy: "●",
                                        msg: "◐"
                                    },
                                    vegan: "✓",
                                    notesEn: "GLUTEN-FREE. Vegan broth — separate pot. MSG possible. Confirm with kitchen.",
                                    notesEs: "SIN GLUTEN. Caldo vegano — olla separada. Posible MSG. Confirma con cocina."
                                },
                                {
                                    itemEn: "Lo Mein",
                                    itemEs: "Lo Mein",
                                    v: {
                                        eggs: "●",
                                        shell: "●",
                                        wheat: "●",
                                        soy: "●",
                                        sesame: "●",
                                        msg: "●"
                                    },
                                    vegan: "✓*",
                                    notesEn: "NOT gluten-free. EGG noodles (wheat + egg) + soy sauce. Sauce = oyster sauce (shellfish-derived) + sesame oil + chicken powder. Our oyster sauce is gluten-free, but the noodles and soy sauce still contain wheat. Vegan Lo Mein is on the menu and uses a separate sauce — confirm with the kitchen before promising vegan or shellfish-free.",
                                    notesEs: "NO es sin gluten. Fideos de HUEVO (trigo + huevo) + salsa de soya. Salsa = ostión (derivado de marisco) + aceite de ajonjolí + polvo de pollo. Nuestra salsa de ostión es sin gluten, pero los fideos y la soya sí llevan trigo. El Lo Mein vegano está en el menú y usa una salsa aparte — confirma con cocina antes de prometer vegano o sin marisco."
                                },
                                {
                                    itemEn: "Fried Rice",
                                    itemEs: "Arroz Frito",
                                    v: {
                                        eggs: "●",
                                        shell: "◐",
                                        wheat: "●",
                                        soy: "●",
                                        msg: "●"
                                    },
                                    vegan: "✓*",
                                    notesEn: "Default has egg (request 'no egg' for vegan). Soy sauce base = SOY + WHEAT — NOT gluten-free.",
                                    notesEs: "Por defecto lleva huevo (pide 'sin huevo' para vegano). Base de salsa de soya = SOYA + TRIGO — NO es sin gluten."
                                },
                                {
                                    itemEn: "Tacos (Roti)",
                                    itemEs: "Tacos (Roti)",
                                    v: {
                                        milk: "◐",
                                        eggs: "◐",
                                        fish: "◐",
                                        shell: "◐",
                                        wheat: "●",
                                        soy: "●"
                                    },
                                    vegan: "✓*",
                                    notesEn: "Roti tortilla = wheat. Mayo-based sauces = egg. Spicy by default.",
                                    notesEs: "Tortilla roti = trigo. Salsas con mayo = huevo. Picante."
                                },
                                {
                                    itemEn: "Banh Mi",
                                    itemEs: "Banh Mi",
                                    v: {
                                        milk: "◐",
                                        eggs: "●",
                                        fish: "◐",
                                        shell: "◐",
                                        wheat: "●",
                                        soy: "●"
                                    },
                                    vegan: "✓*",
                                    notesEn: "Baguette = wheat. Mayo = egg. Spicy by default. May contain dairy in butter.",
                                    notesEs: "Baguette = trigo. Mayo = huevo. Picante. Puede tener lácteo en mantequilla."
                                },
                                {
                                    itemEn: "Bao Sliders",
                                    itemEs: "Bao Sliders",
                                    v: {
                                        milk: "●",
                                        eggs: "◐",
                                        fish: "◐",
                                        shell: "◐",
                                        wheat: "●",
                                        soy: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "CONTAINS DAIRY per menu (bao bun). Flour bao = wheat.",
                                    notesEs: "CONTIENE LÁCTEO según menú (pan bao). Bao = trigo."
                                },
                                {
                                    itemEn: "Spring Rolls (fresh)",
                                    itemEs: "Spring Rolls (frescos)",
                                    v: {
                                        fish: "◐",
                                        shell: "◐",
                                        peanut: "◐",
                                        soy: "◐"
                                    },
                                    vegan: "✓*",
                                    notesEn: "GLUTEN-FREE (rice paper). Peanut sauce is OPTIONAL — only contains peanut if guest adds the peanut sauce dip. Sweet chili dip = peanut-free. Soy only from the protein/sauce you choose.",
                                    notesEs: "SIN GLUTEN (papel de arroz). La salsa de cacahuate es OPCIONAL — sólo lleva cacahuate si el cliente la pide. Sweet chili = sin cacahuate. Soya sólo de la proteína/salsa que elijas."
                                },
                                {
                                    itemEn: "Garlic String Beans",
                                    itemEs: "Ejotes con Ajo",
                                    v: {
                                        soy: "●"
                                    },
                                    vegan: "✓",
                                    notesEn: "Vegan-friendly. Soy in seasoning.",
                                    notesEs: "Apto vegano. Soya en el sazón."
                                }
                            ]
                        },
                        {
                            titleEn: "PROTEINS (add to the base)",
                            titleEs: "PROTEÍNAS (súmalas a la base)",
                            rows: [
                                {
                                    itemEn: "Lemongrass Chicken / Steak",
                                    itemEs: "Pollo / Res con hierba limón",
                                    v: {
                                        fish: "●",
                                        shell: "◐",
                                        soy: "●",
                                        sesame: "●",
                                        msg: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Fish sauce + oyster sauce (shellfish-derived; ours is gluten-free) in the marinade; sesame per official matrix. Gluten-free. MSG in the marinade.",
                                    notesEs: "Salsa de pescado + salsa de ostión (derivada de marisco; la nuestra es sin gluten) en el marinado; ajonjolí según la matriz oficial. Sin gluten. MSG en el marinado."
                                },
                                {
                                    itemEn: "Pork",
                                    itemEs: "Cerdo",
                                    v: {
                                        fish: "●",
                                        wheat: "◐",
                                        soy: "●",
                                        sesame: "●",
                                        msg: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Official matrix lists lemongrass pork (fish sauce, GF). Recipe book Roast Pork is dipped in soy sauce (WHEAT). Ask the kitchen which pork is on the line before calling it gluten-free.",
                                    notesEs: "La matriz oficial lista cerdo con hierba limón (salsa de pescado, sin gluten). El Cerdo Asado del recetario se baña en salsa de soya (TRIGO). Pregunta a cocina cuál cerdo hay antes de decir que es sin gluten."
                                },
                                {
                                    itemEn: "Lemongrass Shrimp",
                                    itemEs: "Camarón con hierba limón",
                                    v: {
                                        fish: "◐",
                                        shell: "●",
                                        soy: "◐",
                                        sesame: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Recipe-book marinade = lemongrass + garlic + SESAME OIL (no fish sauce). Quick-ref and menu still list fish/soy — treat as fish/soy too until the kitchen confirms.",
                                    notesEs: "Marinado del recetario = hierba limón + ajo + ACEITE DE AJONJOLÍ (sin salsa de pescado). La guía rápida y el menú aún marcan pescado/soya — trátalo también como pescado/soya hasta que cocina confirme."
                                },
                                {
                                    itemEn: "Combo (chicken/pork/shrimp/steak)",
                                    itemEs: "Combo (pollo/cerdo/camarón/res)",
                                    v: {
                                        fish: "●",
                                        shell: "●",
                                        soy: "●",
                                        sesame: "●",
                                        msg: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Everything above combined.",
                                    notesEs: "Todo lo anterior combinado."
                                },
                                {
                                    itemEn: "Fried Fish",
                                    itemEs: "Pescado frito",
                                    v: {
                                        eggs: "◐",
                                        fish: "●",
                                        wheat: "◐"
                                    },
                                    vegan: "—",
                                    notesEn: "Cornstarch coating per recipe, but menu lists wheat and the recipe tags egg + shared fryer — do NOT call it gluten-free without kitchen confirmation.",
                                    notesEs: "Cubierto con maicena según receta, pero el menú marca trigo y la receta marca huevo + freidora compartida — NO digas que es sin gluten sin confirmar con cocina."
                                },
                                {
                                    itemEn: "Coconut Shrimp (as protein)",
                                    itemEs: "Camarón con coco (como proteína)",
                                    v: {
                                        eggs: "●",
                                        shell: "●",
                                        treenut: "●",
                                        wheat: "●",
                                        soy: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Coconut = FDA tree nut. Shrimp = shellfish. Wheat + egg breading.",
                                    notesEs: "Coco = fruto seco según FDA. Camarón = marisco. Empanizado de trigo + huevo."
                                },
                                {
                                    itemEn: "Cajun Salmon",
                                    itemEs: "Salmón cajún",
                                    v: {
                                        fish: "●",
                                        soy: "◐"
                                    },
                                    vegan: "—",
                                    notesEn: "Fish. The Cajun rub is spices only per the recipe book, but the menu lists soy for the Salmon Bowl — ask the kitchen before calling it soy-free.",
                                    notesEs: "Pescado. El sazón cajún es sólo especias según el recetario, pero el menú marca soya en el Salmon Bowl — pregunta a cocina antes de decir que es sin soya."
                                },
                                {
                                    itemEn: "Tofu",
                                    itemEs: "Tofu",
                                    v: {
                                        wheat: "●",
                                        soy: "●"
                                    },
                                    vegan: "✓",
                                    notesEn: "Marinated in Kikkoman soy sauce = WHEAT. NOT gluten-free.",
                                    notesEs: "Marinado en salsa de soya Kikkoman = TRIGO. NO es sin gluten."
                                },
                                {
                                    itemEn: "Vegan Beef",
                                    itemEs: "Carne vegana",
                                    v: {
                                        peanut: "◐",
                                        wheat: "●",
                                        soy: "●"
                                    },
                                    vegan: "✓",
                                    notesEn: "Marinade = hoisin + soy sauce (wheat). If the house peanut-butter hoisin is used it is a PEANUT allergen — treat as possible peanut until the kitchen confirms. NOT gluten-free.",
                                    notesEs: "Marinado = hoisin + salsa de soya (trigo). Si se usa el hoisin de la casa con crema de cacahuate es alérgeno de CACAHUATE — trátalo como posible cacahuate hasta que cocina confirme. NO es sin gluten."
                                },
                                {
                                    itemEn: "Vegan Shrimp / Vegan Chikn",
                                    itemEs: "Camarón vegano / Pollo vegano",
                                    v: {
                                        wheat: "●",
                                        soy: "●"
                                    },
                                    vegan: "✓",
                                    notesEn: "Wheat-based plant protein. NOT gluten-free.",
                                    notesEs: "Proteína vegetal a base de trigo. NO es sin gluten."
                                },
                                {
                                    itemEn: "Veggie",
                                    itemEs: "Verduras",
                                    v: {},
                                    vegan: "✓",
                                    notesEn: "The only vegan AND gluten-free protein (per official matrix). Soy depends on sauce.",
                                    notesEs: "La única proteína vegana Y sin gluten (según la matriz oficial). La soya depende de la salsa."
                                },
                                {
                                    itemEn: "Pho: Brisket / Rare Steak / Chicken",
                                    itemEs: "Pho: pecho / bistec / pollo",
                                    v: {},
                                    vegan: "—",
                                    notesEn: "Gluten-free.",
                                    notesEs: "Sin gluten."
                                },
                                {
                                    itemEn: "Pho: Beef Meatball",
                                    itemEs: "Pho: albóndiga",
                                    v: {
                                        wheat: "◐",
                                        soy: "◐"
                                    },
                                    vegan: "—",
                                    notesEn: "Store-bought meatball — may contain soy/wheat.",
                                    notesEs: "Albóndiga comprada — puede tener soya/trigo."
                                },
                                {
                                    itemEn: "Pho: Seafood",
                                    itemEs: "Pho: mariscos",
                                    v: {
                                        fish: "●",
                                        shell: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Shrimp + fish balls/crab/scallop/squid — shellfish AND fish.",
                                    notesEs: "Camarón + bolas de pescado/cangrejo/vieira/calamar — marisco Y pescado."
                                },
                                {
                                    itemEn: "Pho: Spicy Vegan Lemongrass (tofu/mushroom)",
                                    itemEs: "Pho: vegano picante con hierba limón (tofu/hongos)",
                                    v: {
                                        wheat: "●",
                                        soy: "●"
                                    },
                                    vegan: "✓",
                                    notesEn: "Fried tofu = soy-sauce marinade (wheat).",
                                    notesEs: "Tofu frito = marinado de soya (trigo)."
                                }
                            ]
                        },
                        {
                            titleEn: "SNACKS & APPETIZERS",
                            titleEs: "SNACKS Y APERITIVOS",
                            rows: [
                                {
                                    itemEn: "Thai Chili Wings",
                                    itemEs: "Thai Chili Wings",
                                    v: {
                                        wheat: "●",
                                        soy: "●",
                                        sesame: "◐",
                                        msg: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Wing batter = 4 cups all-purpose flour. Sauce may have sesame.",
                                    notesEs: "Empanizado = 4 tazas de harina. La salsa puede tener ajonjolí."
                                },
                                {
                                    itemEn: "Sweet Garlic Wings",
                                    itemEs: "Sweet Garlic Wings",
                                    v: {
                                        wheat: "●",
                                        soy: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Wing batter = flour. Sweet garlic glaze = soy base (16 cups soy sauce).",
                                    notesEs: "Empanizado = harina. Glaseado dulce de ajo = base soya (16 tazas salsa de soya)."
                                },
                                {
                                    itemEn: "Buffalo Sweet Chili Wings",
                                    itemEs: "Buffalo Sweet Chili Wings",
                                    v: {
                                        milk: "◐",
                                        treenut: "◐",
                                        wheat: "●",
                                        soy: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Wing batter = flour. Buffalo sauce may have dairy / tree nut — check label.",
                                    notesEs: "Empanizado = harina. La salsa Buffalo puede tener lácteo / fruto seco — revisa la etiqueta."
                                },
                                {
                                    itemEn: "Crab Rangoons",
                                    itemEs: "Crab Rangoons",
                                    v: {
                                        milk: "●",
                                        eggs: "●",
                                        fish: "●",
                                        wheat: "●",
                                        msg: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Imitation crab is FISH (surimi/white fish), NOT shellfish. Cream cheese = milk. Wonton wrapper = wheat + egg.",
                                    notesEs: "El cangrejo de imitación es PESCADO (surimi/pescado blanco), NO mariscos. Queso crema = lácteo. Envoltura wonton = trigo + huevo."
                                },
                                {
                                    itemEn: "Vietnamese Egg Rolls",
                                    itemEs: "Vietnamese Egg Rolls",
                                    v: {
                                        eggs: "●",
                                        fish: "●",
                                        shell: "◐",
                                        wheat: "●",
                                        soy: "●",
                                        sesame: "●",
                                        msg: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Pork filling + fish sauce + 3 cups sesame oil in mix. Wheat + egg wrapper. Shared fryer.",
                                    notesEs: "Relleno de cerdo + salsa de pescado + 3 tazas de aceite de ajonjolí en la mezcla. Envoltura de trigo + huevo. Freidora compartida."
                                },
                                {
                                    itemEn: "Veggie Egg Rolls",
                                    itemEs: "Veggie Egg Rolls",
                                    v: {
                                        eggs: "●",
                                        wheat: "●",
                                        soy: "●",
                                        sesame: "●",
                                        msg: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Wheat + EGG wrapper, soy + sesame oil in the mix — vegetarian, NOT vegan (kitchen to confirm the wrapper; if an egg-free wrapper is ever used this becomes vegan). Vegan bowls: order NO egg roll. Shared fryer.",
                                    notesEs: "Envoltura de trigo + HUEVO, soya + aceite de ajonjolí en la mezcla — vegetariano, NO vegano (cocina debe confirmar la envoltura; si algún día se usa una envoltura sin huevo, pasa a ser vegano). Bowls veganos: pedir SIN egg roll. Freidora compartida."
                                },
                                {
                                    itemEn: "Vegan Cheese Rolls",
                                    itemEs: "Rollos de Queso Vegano",
                                    v: {
                                        eggs: "◐",
                                        treenut: "●",
                                        wheat: "●",
                                        soy: "●",
                                        msg: "●"
                                    },
                                    vegan: "✓",
                                    notesEn: "Like a crab rangoon but with Kite Hill ALMOND cream cheese = TREE NUT. Wheat wrapper (confirm egg-free). Shared fryer.",
                                    notesEs: "Como un crab rangoon pero con queso crema de ALMENDRA Kite Hill = FRUTO SECO. Envoltura de trigo (confirma que no lleve huevo). Freidora compartida."
                                },
                                {
                                    itemEn: "Fried Shrimp Rolls",
                                    itemEs: "Fried Shrimp Rolls",
                                    v: {
                                        eggs: "●",
                                        shell: "●",
                                        wheat: "●",
                                        soy: "●",
                                        msg: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Shellfish. Wheat breading.",
                                    notesEs: "Mariscos. Empanizado de trigo."
                                },
                                {
                                    itemEn: "Coconut Shrimp",
                                    itemEs: "Coconut Shrimp",
                                    v: {
                                        eggs: "●",
                                        shell: "●",
                                        treenut: "●",
                                        wheat: "●",
                                        soy: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Coconut = FDA tree nut. Shrimp = shellfish.",
                                    notesEs: "Coco = fruto seco según FDA. Camarón = mariscos."
                                },
                                {
                                    itemEn: "Vegan Popcorn Shrimp",
                                    itemEs: "Vegan Popcorn Shrimp",
                                    v: {
                                        wheat: "●",
                                        soy: "●"
                                    },
                                    vegan: "✓",
                                    notesEn: "Plant-based. Wheat breading.",
                                    notesEs: "A base de plantas. Empanizado de trigo."
                                },
                                {
                                    itemEn: "Buffalo Sweet Chili Tofu",
                                    itemEs: "Buffalo Sweet Chili Tofu",
                                    v: {
                                        milk: "◐",
                                        treenut: "◐",
                                        wheat: "◐",
                                        soy: "●"
                                    },
                                    vegan: "✓",
                                    notesEn: "Tofu = soy. Buffalo sauce may contain dairy AND wheat — confirm with the kitchen before calling it dairy-free or gluten-free (menu lists it vegan; verify the sauce label).",
                                    notesEs: "Tofu = soya. La salsa Buffalo puede tener lácteo Y trigo — confirma con cocina antes de decir que es sin lácteo o sin gluten (el menú lo marca vegano; revisa la etiqueta de la salsa)."
                                },
                                {
                                    itemEn: "Sweet Potato Waffle Fries",
                                    itemEs: "Papas Waffle de Camote",
                                    v: {},
                                    vegan: "✓",
                                    notesEn: "Check fryer oil for shared use.",
                                    notesEs: "Verifica si la freidora se comparte."
                                }
                            ]
                        }
                    ]
                }
            },
            {
                id: "m17-l4",
                titleEn: "Allergen Matrix — Desserts, Sauces & Beverages",
                titleEs: "Matriz de Alérgenos — Postres, Salsas y Bebidas",
                contentEn: [
                    "Page 2 of the official chart. Same legend: ● contains, ◐ may contain, blank = doesn't typically contain, ✓ vegan, ✓* can be made vegan.",
                    "⚠ This chart is for staff reference. Vietnamese cooking commonly uses fish sauce, soy sauce, sesame, and peanuts — cross-contact is always possible. ALWAYS confirm allergies with a manager and the kitchen before serving. Never guess."
                ],
                contentEs: [
                    "Página 2 de la tabla oficial. Misma leyenda: ● contiene, ◐ puede contener, en blanco = no contiene típicamente, ✓ vegano, ✓* se puede hacer vegano.",
                    "⚠ Esta tabla es para referencia del personal. La cocina vietnamita usa salsa de pescado, soya, ajonjolí y cacahuate — el contacto cruzado siempre es posible. SIEMPRE confirma alergias con el líder de turno y la cocina antes de servir. Nunca adivines."
                ],
                matrix: {
                    sections: [
                        {
                            titleEn: "DESSERTS",
                            titleEs: "POSTRES",
                            rows: [
                                {
                                    itemEn: "Passion Fruit Mousse",
                                    itemEs: "Mousse de Maracuyá",
                                    v: {
                                        milk: "●",
                                        eggs: "●",
                                        wheat: "◐"
                                    },
                                    vegan: "—",
                                    notesEn: "Dairy mousse. Check gelatin.",
                                    notesEs: "Mousse lácteo. Verifica gelatina."
                                },
                                {
                                    itemEn: "Flan",
                                    itemEs: "Flan",
                                    v: {
                                        milk: "●",
                                        eggs: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Eggs, milk, sugar — classic custard.",
                                    notesEs: "Huevos, leche, azúcar — flan clásico."
                                },
                                {
                                    itemEn: "Sesame Balls",
                                    itemEs: "Bolas de Ajonjolí",
                                    v: {
                                        sesame: "●"
                                    },
                                    vegan: "✓",
                                    notesEn: "Sesame seeds! Glutinous rice (no wheat gluten).",
                                    notesEs: "¡Semillas de ajonjolí! Arroz glutinoso (sin gluten de trigo)."
                                },
                                {
                                    itemEn: "Vietnamese Churros + Ganache",
                                    itemEs: "Churros Vietnamitas + Ganache",
                                    v: {
                                        milk: "●",
                                        eggs: "●",
                                        wheat: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Fried dough (wheat + egg) — shared fryer. Ganache = condensed milk + heavy cream + white chocolate (dairy).",
                                    notesEs: "Masa frita (trigo + huevo) — freidora compartida. Ganache = leche condensada + crema + chocolate blanco (lácteo)."
                                },
                                {
                                    itemEn: "Vegan Chocolate Cake",
                                    itemEs: "Pastel de Chocolate Vegano",
                                    v: {
                                        wheat: "●",
                                        soy: "●"
                                    },
                                    vegan: "✓",
                                    notesEn: "Plant-based. Wheat flour, likely soy.",
                                    notesEs: "A base de plantas. Harina de trigo, probable soya."
                                },
                                {
                                    itemEn: "Tres Leches Cake",
                                    itemEs: "Pastel Tres Leches",
                                    v: {
                                        milk: "●",
                                        eggs: "●",
                                        wheat: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Three dairies + egg + wheat cake.",
                                    notesEs: "Tres lácteos + huevo + pastel de trigo."
                                },
                                {
                                    itemEn: "Strawberry Matcha Tres Leches",
                                    itemEs: "Tres Leches de Fresa Matcha",
                                    v: {
                                        milk: "●",
                                        eggs: "●",
                                        wheat: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Same as tres leches + matcha.",
                                    notesEs: "Igual a tres leches + matcha."
                                },
                                {
                                    itemEn: "Viet Coffee Tres Leches",
                                    itemEs: "Tres Leches de Café Vietnamita",
                                    v: {
                                        milk: "●",
                                        eggs: "●",
                                        wheat: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Same as tres leches + coffee.",
                                    notesEs: "Igual a tres leches + café."
                                },
                                {
                                    itemEn: "Vegan Iced Oatmeal Cookies",
                                    itemEs: "Galletas Veganas de Avena Glaseadas",
                                    v: {
                                        wheat: "●",
                                        soy: "●"
                                    },
                                    vegan: "✓",
                                    notesEn: "Oats cross-contact with wheat. Soy common.",
                                    notesEs: "Avena con contacto cruzado con trigo. Soya común."
                                }
                            ]
                        },
                        {
                            titleEn: "SAUCES",
                            titleEs: "SALSAS",
                            rows: [
                                {
                                    itemEn: "DD Dressing",
                                    itemEs: "Aderezo DD",
                                    v: {
                                        eggs: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Egg yolks + oil + pickled medley + sugar. NO soy, fish, or wheat. Egg-allergy = skip.",
                                    notesEs: "Yemas + aceite + mezcla de encurtidos + azúcar. SIN soya, pescado ni trigo. Alergia al huevo = no servir."
                                },
                                {
                                    itemEn: "Spicy DD",
                                    itemEs: "Spicy DD",
                                    v: {
                                        eggs: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "DD base + Sriracha + cayenne. Egg yolks only — no soy/fish/wheat.",
                                    notesEs: "Base DD + Sriracha + cayena. Solo yemas — sin soya/pescado/trigo."
                                },
                                {
                                    itemEn: "Vietnamese Vinaigrette",
                                    itemEs: "Vinagreta Vietnamita",
                                    v: {
                                        fish: "●",
                                        msg: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Fish sauce (nuoc mam) base. MSG added.",
                                    notesEs: "Base de salsa de pescado (nuoc mam). Lleva MSG."
                                },
                                {
                                    itemEn: "Vegan Vietnamese Vinaigrette",
                                    itemEs: "Vinagreta Vietnamita Vegana",
                                    v: {
                                        soy: "●"
                                    },
                                    vegan: "✓",
                                    notesEn: "Soy replaces fish sauce.",
                                    notesEs: "La soya reemplaza a la salsa de pescado."
                                },
                                {
                                    itemEn: "Peanut Dressing (Peanut Sauce)",
                                    itemEs: "Peanut Dressing (Salsa de Cacahuate)",
                                    v: {
                                        peanut: "●",
                                        wheat: "●",
                                        soy: "●"
                                    },
                                    vegan: "✓",
                                    notesEn: "Peanut butter + our house hoisin + sugar. Hoisin contains wheat. NO shellfish.",
                                    notesEs: "Crema de cacahuate + nuestro hoisin de la casa + azúcar. Hoisin lleva trigo. SIN mariscos."
                                },
                                {
                                    itemEn: "Spicy Peanut Dressing",
                                    itemEs: "Spicy Peanut Dressing (Salsa Picante de Cacahuate)",
                                    v: {
                                        peanut: "●",
                                        wheat: "●",
                                        soy: "●"
                                    },
                                    vegan: "✓",
                                    notesEn: "Peanut dressing + cayenne. Same allergens. NO shellfish.",
                                    notesEs: "Peanut dressing + cayena. Mismos alérgenos. SIN mariscos."
                                },
                                {
                                    itemEn: "Hoisin (DD Mau version)",
                                    itemEs: "Hoisin (versión DD Mau)",
                                    v: {
                                        peanut: "●",
                                        wheat: "●",
                                        soy: "●"
                                    },
                                    vegan: "✓",
                                    notesEn: "Our house recipe — peanut butter + base hoisin + soy. Contains wheat. NO shellfish (despite some commercial hoisin brands containing oyster extract — ours doesn't).",
                                    notesEs: "Receta de la casa — crema de cacahuate + hoisin base + soya. Lleva trigo. SIN mariscos (aunque algunos hoisin comerciales tienen extracto de ostión — el nuestro no)."
                                },
                                {
                                    itemEn: "Sweet Chili",
                                    itemEs: "Sweet Chili",
                                    v: {},
                                    vegan: "✓",
                                    notesEn: "Typically allergen-clean.",
                                    notesEs: "Típicamente sin alérgenos comunes."
                                },
                                {
                                    itemEn: "Creamy Sweet Chili",
                                    itemEs: "Creamy Sweet Chili",
                                    v: {
                                        milk: "◐",
                                        eggs: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Creamy base — mayo (egg). May contain dairy — confirm with kitchen before serving to a milk allergy.",
                                    notesEs: "Base cremosa — mayo (huevo). Puede tener lácteo — confirma con cocina antes de servir a alguien con alergia a la leche."
                                },
                                {
                                    itemEn: "Lime Ranch",
                                    itemEs: "Lime Ranch",
                                    v: {
                                        milk: "●",
                                        eggs: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Ranch = dairy + egg (buttermilk, mayo).",
                                    notesEs: "Ranch = lácteo + huevo (suero de leche, mayo)."
                                },
                                {
                                    itemEn: "Chili Oil",
                                    itemEs: "Aceite de Chile",
                                    v: {},
                                    vegan: "✓",
                                    notesEn: "Typically clean. Confirm no sesame oil blend.",
                                    notesEs: "Típicamente limpio. Confirma que no sea mezcla con aceite de ajonjolí."
                                },
                                {
                                    itemEn: "Sambal",
                                    itemEs: "Sambal",
                                    v: {},
                                    vegan: "✓",
                                    notesEn: "Chili paste — typically clean.",
                                    notesEs: "Pasta de chile — típicamente limpia."
                                },
                                {
                                    itemEn: "Sriracha",
                                    itemEs: "Sriracha",
                                    v: {},
                                    vegan: "✓",
                                    notesEn: "Typically clean.",
                                    notesEs: "Típicamente limpia."
                                }
                            ]
                        },
                        {
                            titleEn: "BEVERAGES (key allergens)",
                            titleEs: "BEBIDAS (alérgenos principales)",
                            rows: [
                                {
                                    itemEn: "Matcha Latte, Masala Chai",
                                    itemEs: "Matcha Latte, Masala Chai",
                                    v: {
                                        milk: "●",
                                        treenut: "◐",
                                        soy: "◐"
                                    },
                                    vegan: "—",
                                    notesEn: "Real milk default — true dairy. Oat or soy milk safe substitutes for milk allergy. Almond milk = tree nut allergen. Confirm sub before ringing.",
                                    notesEs: "Leche real por defecto — lácteo verdadero. Avena o soya son sustitutos seguros para alergia a leche. Almendra = fruto seco. Confirma sustitución antes de cobrar."
                                },
                                {
                                    itemEn: "Vietnamese Coffee/Latte",
                                    itemEs: "Café Vietnamita / Latte",
                                    v: {
                                        milk: "●"
                                    },
                                    vegan: "—",
                                    notesEn: "Made with condensed milk per recipe — true dairy. Cannot be subbed without changing the drink fundamentally.",
                                    notesEs: "Hecho con leche condensada por receta — lácteo verdadero. No se puede sustituir sin cambiar la bebida fundamentalmente."
                                },
                                {
                                    itemEn: "Thai Iced Tea",
                                    itemEs: "Thai Iced Tea",
                                    v: {
                                        milk: "●",
                                        treenut: "◐",
                                        soy: "◐"
                                    },
                                    vegan: "—",
                                    notesEn: "Condensed milk default — true dairy. Oat or soy safe for milk allergy. Almond = tree nut.",
                                    notesEs: "Leche condensada por defecto — lácteo verdadero. Avena o soya seguras para alergia a leche. Almendra = fruto seco."
                                },
                                {
                                    itemEn: "All Boba Milk Teas (9 flavors)",
                                    itemEs: "Todos los Boba Milk Teas (9 sabores)",
                                    v: {
                                        milk: "●",
                                        treenut: "◐",
                                        soy: "◐"
                                    },
                                    vegan: "—",
                                    notesEn: "⚠ CRITICAL — the milk-tea BASE is a milk powder with non-dairy creamer pre-mixed in. The creamer contains sodium caseinate + lactose + milk flavor — all milk derivatives. We CANNOT take the creamer out. Subbing oat or almond milk does NOT remove the allergen — the base itself is the problem. For a milk allergy, redirect the guest to a FRUIT TEA (only safe option, never touches the base). Tapioca pearls themselves are typically allergen-free. Cashier MUST give the boba disclosure on every milk tea order. Say it verbatim (same script as M6): 'Just so you know, our boba milk teas use a milk-powder base that already has a non-dairy creamer mixed in — we can't take the creamer out, and the creamer is made from a milk derivative. So if you have a milk allergy, please don't order one. Our fruit teas are completely safe — they never touch the milk powder.' Lactose-intolerant (digestion only) = usually fine; ALLERGY = fruit tea.",
                                    notesEs: "⚠ CRÍTICO — la BASE del milk tea es una leche en polvo con la crema non-dairy pre-mezclada. La crema contiene caseinato de sodio + lactosa + sabor de leche — todos derivados lácteos. NO podemos quitar la crema. Cambiar a leche de avena o almendra NO elimina el alérgeno — la base es el problema. Para alergia a la leche, redirige al cliente a un FRUIT TEA (única opción segura, nunca toca la base). Las perlas de tapioca en sí típicamente no tienen alérgenos. El cajero DEBE dar el aviso de boba en cada orden de milk tea. Dilo al pie de la letra (mismo guion que M6): 'Para que sepa, nuestros boba milk teas usan una base de leche en polvo que ya tiene la crema non-dairy mezclada — no podemos quitar la crema, y la crema está hecha de un derivado lácteo. Así que si tiene alergia a la leche, por favor no lo ordene. Nuestros fruit teas son completamente seguros — nunca tocan la leche en polvo.' Intolerante a la lactosa (solo digestión) = normalmente bien; ALERGIA = fruit tea."
                                },
                                {
                                    itemEn: "Lychee Limeade, Boba Fruit Teas, Slushies, Hot Teas",
                                    itemEs: "Lychee Limeade, Boba Fruit Teas, Slushies, Tés Calientes",
                                    v: {},
                                    vegan: "✓",
                                    notesEn: "Fruit & plain-tea drinks — no common allergens. SAFE for milk allergies: fruit teas never touch the milk-powder base used by milk teas. This is the ONLY milk-allergy-safe path on the boba menu. Recommend these as the go-to substitute when a guest with a milk allergy asks about boba.",
                                    notesEs: "Bebidas de fruta y té solo — sin alérgenos comunes. SEGURAS para alergia a leche: los fruit teas nunca tocan la base de leche en polvo que usan los milk teas. Esta es la ÚNICA opción segura en el menú de boba para alergia a la leche. Recomiéndalos como la sustitución principal cuando un cliente con alergia a la leche pregunte por boba."
                                }
                            ]
                        }
                    ]
                }
            }
        ],
        quiz: {
            passThreshold: 0.85,
            questions: [
                {
                    id: "m17-q1",
                    questionEn: "When a guest tells you they have a serious allergy, the FIRST thing you do is:",
                    questionEs: "Cuando un cliente te dice que tiene alergia grave, lo PRIMERO que haces es:",
                    options: [
                        {
                            id: "a",
                            textEn: "Tell them what's safe based on what you remember",
                            textEs: "Dile qué es seguro según lo que recuerdes"
                        },
                        {
                            id: "b",
                            textEn: "Stop, get the Shift Lead, and let them confirm",
                            textEs: "Para, llama al líder y deja que confirme"
                        },
                        {
                            id: "c",
                            textEn: "Take the order and put it through carefully",
                            textEs: "Toma la orden y mándala con cuidado"
                        },
                        {
                            id: "d",
                            textEn: "Tell them to check the menu allergen card",
                            textEs: "Dile que revise la tarjeta de alérgenos del menú"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m17-q2",
                    questionEn: "Vermicelli Bowl by default comes with:",
                    questionEs: "El Vermicelli Bowl por defecto viene con:",
                    options: [
                        {
                            id: "a",
                            textEn: "Crushed peanuts on top + Vietnamese egg roll",
                            textEs: "Cacahuates molidos encima + egg roll vietnamita"
                        },
                        {
                            id: "b",
                            textEn: "No peanuts, no egg roll",
                            textEs: "Sin cacahuates, sin egg roll"
                        },
                        {
                            id: "c",
                            textEn: "Almond crumbs + spring roll",
                            textEs: "Migas de almendra + spring roll (rollo fresco)"
                        },
                        {
                            id: "d",
                            textEn: "Just rice noodles and dressing",
                            textEs: "Solo fideos de arroz y aderezo"
                        }
                    ],
                    correct: "a"
                },
                {
                    id: "m17-q3",
                    questionEn: "A guest is allergic to FISH. Which is NOT safe?",
                    questionEs: "Un cliente es alérgico a PESCADO. ¿Cuál NO es seguro?",
                    options: [
                        {
                            id: "a",
                            textEn: "Tofu Rice Bowl with Sweet Chili",
                            textEs: "Tofu Rice Bowl con Sweet Chili"
                        },
                        {
                            id: "b",
                            textEn: "Vegan Beef Vermicelli Bowl, no egg roll, with Vegan Vinaigrette",
                            textEs: "Vermicelli Bowl de Carne Vegana, sin egg roll, con Vinagreta Vegana"
                        },
                        {
                            // 2026-06-20 (QA audit T6) — was "DD Dressing", which the
                            // allergen matrix marks fish-FREE (eggs only), so this
                            // "not safe" answer actually had no fish — and both this
                            // and option (a) were Rice Bowls, making the question
                            // unanswerable. Vietnamese Vinaigrette is the one item the
                            // matrix marks fish:● (nuoc mam fish-sauce base), so it's
                            // the unambiguous fish-allergy hazard.
                            id: "c",
                            textEn: "Lemongrass Chicken Rice Bowl with Vietnamese Vinaigrette",
                            textEs: "Rice Bowl de Pollo con Hierba Limón con Vinagreta Vietnamita"
                        },
                        {
                            id: "d",
                            textEn: "Veggie Spring Rolls with Sweet Chili",
                            textEs: "Spring Rolls Vegetarianos con Sweet Chili"
                        }
                    ],
                    correct: "c"
                },
                {
                    id: "m17-q4",
                    questionEn: "Vegan Cream Cheese is made from:",
                    questionEs: "El Queso Crema Vegano se hace de:",
                    options: [
                        {
                            id: "a",
                            textEn: "Soy",
                            textEs: "Soya"
                        },
                        {
                            id: "b",
                            textEn: "Almond (tree nut allergen)",
                            textEs: "Almendra (alérgeno de fruto seco)"
                        },
                        {
                            id: "c",
                            textEn: "Coconut",
                            textEs: "Coco"
                        },
                        {
                            id: "d",
                            textEn: "Dairy",
                            textEs: "Lácteos"
                        }
                    ],
                    correct: "b"
                },
                {
                    id: "m17-q5",
                    questionEn: "Our oyster sauce is:",
                    questionEs: "Nuestra salsa de ostión es:",
                    options: [
                        {
                            id: "a",
                            textEn: "Gluten-free (verified)",
                            textEs: "Sin gluten (verificado)"
                        },
                        {
                            id: "b",
                            textEn: "Contains wheat",
                            textEs: "Contiene trigo"
                        },
                        {
                            id: "c",
                            textEn: "Vegan",
                            textEs: "Vegana"
                        },
                        {
                            id: "d",
                            textEn: "Dairy-based",
                            textEs: "A base de lácteos"
                        }
                    ],
                    correct: "a"
                },
                {
                    id: "m17-q6",
                    questionEn: "A guest with PEANUT allergy orders a Vermicelli Bowl (crushed peanuts left off the topping). What sauces are SAFE for them?",
                    questionEs: "Un cliente con alergia a CACAHUATE ordena Vermicelli Bowl (sin cacahuate molido encima). ¿Qué salsas SON seguras?",
                    options: [
                        {
                            id: "a",
                            textEn: "Peanut Dressing only",
                            textEs: "Solo Peanut Dressing"
                        },
                        {
                            id: "b",
                            textEn: "Hoisin (it's our house version)",
                            textEs: "Hoisin (es nuestra versión casera)"
                        },
                        {
                            id: "c",
                            textEn: "Vietnamese Vinaigrette, Vegan Vinaigrette, Sweet Chili, DD, Spicy DD",
                            textEs: "Vinagreta Vietnamita, Vinagreta Vegana, Sweet Chili, DD, Spicy DD"
                        },
                        {
                            id: "d",
                            textEn: "Spicy Peanut only",
                            textEs: "Solo Spicy Peanut"
                        }
                    ],
                    correct: "c"
                },
                {
                    id: "m17-q7",
                    questionEn: "For a VEGAN guest, which sauce is NOT vegan?",
                    questionEs: "Para un cliente VEGANO, ¿cuál salsa NO es vegana?",
                    options: [
                        {
                            id: "a",
                            textEn: "Vegan Vinaigrette",
                            textEs: "Vinagreta Vegana"
                        },
                        {
                            id: "b",
                            textEn: "Sweet Chili",
                            textEs: "Sweet Chili"
                        },
                        {
                            id: "c",
                            textEn: "DD Dressing",
                            textEs: "DD Dressing (Aderezo DD)"
                        },
                        {
                            id: "d",
                            textEn: "Hoisin (DD Mau house)",
                            textEs: "Hoisin (estilo DD Mau)"
                        }
                    ],
                    correct: "c"
                }
            ]
        }
    },
    // ── M18 — Wet Floors & Spills (Andrew 2026-08-18) ──────────────────
    // "When we see, or cause a spill or spot a wet floor … we don't leave
    // the spot without putting up a caution. They guard the wet floor
    // until a caution sign can be put up and cleaned up." First module on
    // the Service & Safety track. Published 2026-08-19 after Andrew's review
    // (lone-worker exception kept; sign locations = trash area + drinks shelf).
    // 2026-08-19 review pass: glass-near-food rule, hand-wash after floor
    // contact, absorb-then-degrease, lone-worker exception made explicit,
    // store-specific facts kept neutral (sign locations are the owner's).
    {
        id: "m18",
        code: "M18",
        track: "service-safety",
        tier: "all",
        icon: "⚠️",
        durationMin: 8,
        titleEn: "Wet Floors & Spills — Guard It Until It's Safe",
        titleEs: "Pisos Mojados y Derrames — Cuídalo Hasta Que Esté Seguro",
        lessons: [
            {
                id: "m18-l1",
                titleEn: "You See It, You Own It",
                titleEs: "Si Lo Ves, Es Tuyo",
                contentEn: [
                    "Slips and falls are the most common injury in restaurants — for guests and for us. A wet spot the size of a dinner plate is enough to put someone on the floor, and a guest can walk through a puddle nobody is guarding before you finish saying \"wet floor\".",
                    "The DD Mau rule is simple: if you SEE a spill or a wet floor, or you CAUSE one, that spot is yours until it is safe. You do not walk away from it. Not to grab a sign while someone else can bring it, not to finish an order, not because it's \"just water\".",
                    "Safe means three things, in this order: people are warned, a yellow caution sign is standing on the spot, and the floor has been cleaned AND is completely dry. Until all three are done, somebody is standing guard — and that somebody is you.",
                    "This counts everywhere guests and front-of-house staff walk: dining room, boba station, entrance, behind the register, the hallway to the restrooms. The kitchen is different for plain water — everyone back there wears non-slip shoes (see Lesson 3) — but grease and broken glass follow the full rule anywhere, front or back.",
                    "It also counts for everything slick: water, ice, grease, sauce, broken glass, a leaking mop bucket, rain and snow that people bring in on their shoes. If a shoe could slide on it, it's a wet floor.",
                    "Why it matters beyond the injury: if a guest falls, it can cost the restaurant a lot of money — some restaurants have closed because of one fall. A coworker who falls is out of work for weeks and the rest of the team covers the shifts. Thirty seconds of standing guard is the cheapest insurance we have."
                ],
                contentEs: [
                    "Los resbalones y caídas son la lesión más común en los restaurantes — para los clientes y para nosotros. Una mancha mojada del tamaño de un plato basta para tirar a alguien al piso, y un cliente puede cruzar un charco que nadie está cuidando antes de que termines de decir \"piso mojado\".",
                    "La regla de DD Mau es simple: si VES un derrame o un piso mojado, o lo CAUSAS, ese lugar es tuyo hasta que esté seguro. No te alejas de ahí. Ni para ir por un letrero cuando otro lo puede traer, ni para terminar una orden, ni porque \"solo es agua\".",
                    "Seguro significa tres cosas, en este orden: la gente está avisada, hay un letrero amarillo de precaución parado en el lugar, y el piso está limpio Y completamente seco. Hasta que se cumplan las tres, alguien está montando guardia — y ese alguien eres tú.",
                    "Esto aplica en todos los lugares por donde pasan los clientes y el personal del frente: comedor, estación de boba, entrada, detrás de la caja, el pasillo a los baños. La cocina es diferente para el agua sola — todos ahí atrás usan zapatos antiderrapantes (ver Lección 3) — pero la grasa y el vidrio roto siguen la regla completa en cualquier parte, al frente o atrás.",
                    "También aplica a todo lo resbaloso: agua, hielo, grasa, salsa, vidrio roto, una cubeta del trapeador que gotea, lluvia y nieve que la gente mete con los zapatos al entrar. Si un zapato puede deslizarse, es un piso mojado.",
                    "Por qué importa más allá de la lesión: si un cliente se cae, le puede costar al restaurante mucho dinero — algunos restaurantes han cerrado por una sola caída. Un compañero que se cae pasa semanas sin poder trabajar y el resto del equipo cubre sus turnos. Treinta segundos montando guardia son el seguro más barato que tenemos."
                ]
            },
            {
                id: "m18-l2",
                titleEn: "The 5 Steps — Every Time",
                titleEs: "Los 5 Pasos — Siempre",
                contentEn: [
                    "1. STOP AND STAY. Stand next to the spot — not in it — with your body between the wet area and the people walking. If you're carrying food, set it down on the nearest clean surface. The floor comes first.",
                    "2. WARN. Say it loud, the same way you call \"behind!\": \"Wet floor!\" / \"¡Piso mojado!\" Wave people around it — guests, kids, coworkers carrying trays. Nobody crosses the spot while you're there.",
                    "3. CALL FOR THE SIGN AND SUPPLIES — YOU STAY. Call to the nearest coworker by name: \"Marcos — caution sign and towels to the boba station, please.\" Call twice if you have to. The only exception: you are the only person in the building and nobody can hear you. Then a barrier is your caution — put a chair, a tray stand or an upside-down bus tub right on the spot, get the sign fast, and come straight back. A barrier is the backup, never the plan.",
                    "4. PUT THE SIGN UP FIRST, THEN CLEAN. The yellow sign stands on the side people walk from, before the first towel touches the floor. Then clean it the right way: paper towels or a dry mop for water and ice. Grease: soak it up with paper towels first, THEN degreaser and the kitchen mop, then dry — never plain water on grease (it spreads) and never cardboard over it (it hides the grease and slides out from under you). Broken glass: broom and dustpan, then a damp paper towel for the tiny pieces — never your hands. Glass goes in a box or a doubled bag, never loose in the trash.",
                    "5. KEEP THE SIGN UP UNTIL IT IS COMPLETELY DRY. Dry the spot with paper towels or a floor-only towel — never a sani-bucket towel or a table towel — and check it with the back of your hand. Damp is still wet. Only the person who cleaned it takes the sign down — not whoever walks past. Put the sign back where it lives, then WASH YOUR HANDS before you touch food, the register, or a clean towel (floor + chemicals = wash, same rule as M3).",
                    "Then tell the Shift Lead if it was a big spill, anything greasy, broken glass, or if any guest was near it — and ALWAYS if anyone slipped, even if they say they're fine.",
                    "Where the caution signs live: one by the trash area and one by the drinks shelf. Walk to both with your Shift Lead on day one so you can grab one without thinking — that's a fair question, not a dumb one."
                ],
                contentEs: [
                    "1. DETENTE Y QUÉDATE. Párate junto al lugar — no encima — con tu cuerpo entre el área mojada y la gente que pasa. Si llevas comida, déjala en la superficie limpia más cercana. El piso va primero.",
                    "2. AVISA. Dilo fuerte, igual que cuando gritas \"¡atrás!\": \"¡Piso mojado!\" / \"Wet floor!\" Haz que la gente rodee el lugar — clientes, niños, compañeros con bandejas. Nadie cruza el lugar mientras tú estés ahí.",
                    "3. PIDE EL LETRERO Y LOS MATERIALES — TÚ TE QUEDAS. Llama al compañero más cercano por su nombre: \"Marcos — letrero de precaución y toallas a la estación de boba, por favor.\" Grita dos veces si hace falta. La única excepción: eres la única persona en el local y nadie te puede oír. Entonces una barrera es tu precaución — pon una silla, un soporte de bandejas o un bus tub volteado boca abajo justo en el lugar, ve rápido por el letrero y regresa directo. La barrera es el respaldo, nunca el plan.",
                    "4. PRIMERO PON EL LETRERO, DESPUÉS LIMPIA. El letrero amarillo se para del lado por donde viene la gente, antes de que la primera toalla toque el piso. Luego limpia bien: toallas de papel o trapeador seco para agua y hielo. Grasa: primero absórbela con toallas de papel, DESPUÉS desengrasante y el trapeador de la cocina, y luego seca — nunca agua sola sobre grasa (la esparce) y nunca cartón encima (esconde la grasa y se resbala bajo tus pies). Vidrio roto: escoba y recogedor, y después una toalla de papel húmeda para los pedacitos — nunca con las manos. El vidrio va en una caja o bolsa doble, nunca suelto en la basura.",
                    "5. DEJA EL LETRERO HASTA QUE ESTÉ COMPLETAMENTE SECO. Seca el lugar con toallas de papel o una toalla solo para pisos — nunca una toalla de la cubeta de sanitizante ni una de mesas — y revisa con el dorso de la mano. Húmedo sigue siendo mojado. Solo la persona que limpió quita el letrero — no cualquiera que pase por ahí. Regresa el letrero a su lugar y luego LÁVATE LAS MANOS antes de tocar comida, la caja o una toalla limpia (piso + químicos = lavarse, misma regla que M3).",
                    "Luego avísale al líder de turno si fue un derrame grande, algo con grasa, vidrio roto, o si algún cliente estaba cerca — y SIEMPRE si alguien se resbaló, aunque diga que está bien.",
                    "Dónde están los letreros de precaución: uno junto al área de la basura y uno junto al estante de las bebidas. Ve a los dos con tu líder de turno el primer día para que puedas agarrar uno sin pensarlo — es una pregunta válida, no una pregunta tonta."
                ]
            },
            {
                id: "m18-l3",
                titleEn: "Hot Spots & Special Cases",
                titleEs: "Puntos Críticos y Casos Especiales",
                contentEn: [
                    "BOBA STATION AND ICE. Dropped ice is water in two minutes. Every piece gets picked up or swept now — not after the rush. On a busy shift, give the boba-station floor a dry-towel check every time you restock.",
                    "ENTRANCE ON RAIN AND SNOW DAYS. Mats go down before we open and a caution sign stands by the door all day. Whoever is on Dining Room or Cashier checks the floor just inside the door every 15 minutes and dries it — guests bring water in on their shoes with every visit.",
                    "WHILE YOU MOP. The mop bucket is a wet floor too. Put a sign at both ends of a mopped hallway, mop small sections so there's always a dry path, and never leave the bucket blocking a doorway.",
                    "BACK OF HOUSE IS DIFFERENT FOR WATER. Everyone in the kitchen wears non-slip shoes and water on the kitchen floor is part of the job — squeegee it to the drain when you can and keep moving; no sign needed for plain water behind the line or in the dish pit. Two exceptions: GREASE (non-slip shoes don't hold on grease — grease by the fryer gets soaked up and degreased right away) and BROKEN GLASS (swept immediately). And the moment water reaches somewhere a guest or a front-of-house coworker in regular shoes walks — the hallway to the restrooms, the door into the dining room — it's back to the full rule.",
                    "BROKEN GLASS OR A DROPPED DRINK NEAR A GUEST'S TABLE. Apologize, guard, and don't rush the guest — they stay seated while you clean. Sweep, don't hand-pick. And if the glass broke near open food, ice, or a guest's bowl: anything it could have landed in gets thrown out — no checking, no picking pieces out. An ice bin gets dumped, washed, sanitized and refilled. A guest's food or drink near the break gets replaced (the Lead comps it).",
                    "IF SOMEONE SLIPS OR FALLS. Call for the Shift Lead immediately. Do not move anyone who is hurt. Keep guarding the spot so nobody else goes down. The Lead takes care of the guest and writes down what happened — your job is to stay calm and keep the area safe.",
                    "The short version you should be able to say in your sleep: see it → stay → warn → call for the sign → sign up first, clean, dry → wash hands → take the sign down → tell the Lead if it was serious."
                ],
                contentEs: [
                    "ESTACIÓN DE BOBA Y HIELO. El hielo tirado es agua en dos minutos. Cada hielo se recoge o se barre ahora — no después del rush. En un turno ocupado, revisa el piso de la estación de boba con una toalla seca cada vez que surtes.",
                    "ENTRADA EN DÍAS DE LLUVIA Y NIEVE. Los tapetes se ponen antes de abrir y un letrero de precaución se queda junto a la puerta todo el día. Quien esté en Comedor o Caja revisa el piso justo adentro de la puerta cada 15 minutos y lo seca — los clientes meten agua con los zapatos cada vez que entran.",
                    "MIENTRAS TRAPEAS. La cubeta del trapeador también es un piso mojado. Pon letrero en los dos extremos de un pasillo trapeado, trapea por secciones pequeñas para que siempre haya un camino seco, y nunca dejes la cubeta atravesada en el paso de una puerta.",
                    "LA COCINA ES DIFERENTE PARA EL AGUA. Todos en la cocina usan zapatos antiderrapantes y el agua en el piso de la cocina es parte del trabajo — empújala con el jalador hacia la coladera cuando puedas y sigue; no hace falta letrero para agua sola detrás de la línea o en el área de lavado. Dos excepciones: la GRASA (los zapatos antiderrapantes no agarran en la grasa — la grasa junto a la freidora se absorbe y se desengrasa de inmediato) y el VIDRIO ROTO (se barre de inmediato). Y en cuanto el agua llega a un lugar por donde pasa un cliente o un compañero del frente con zapatos normales — el pasillo a los baños, la puerta al comedor — vuelve la regla completa.",
                    "VIDRIO ROTO O BEBIDA TIRADA JUNTO A LA MESA DE UN CLIENTE. Discúlpate, cuida el lugar y no apresures al cliente — que se quede sentado mientras limpias. Barre, no recojas con la mano. Y si el vidrio se rompió cerca de comida abierta, hielo o el tazón de un cliente: todo donde pudo haber caído se tira — sin revisar, sin sacar pedacitos. Un depósito de hielo se vacía, se lava, se sanitiza y se vuelve a llenar. La comida o bebida de un cliente cerca del vidrio se reemplaza (el líder la da de cortesía).",
                    "SI ALGUIEN SE RESBALA O SE CAE. Llama al líder de turno de inmediato. No muevas a nadie que esté lastimado. Sigue cuidando el lugar para que nadie más se caiga. El líder atiende al cliente y anota lo que pasó — tu trabajo es mantener la calma y el área segura.",
                    "La versión corta que debes poder decir hasta dormido: lo ves → te quedas → avisas → pides el letrero → pones el letrero, limpias, secas → te lavas las manos → quitas el letrero → avisas al líder si fue serio."
                ]
            }
        ],
        quiz: {
            passThreshold: 0.85,
            questions: [
                {
                    id: "m18-q1",
                    questionEn: "You drop a cup of ice at the boba station. The nearest caution sign is in the back. What do you do?",
                    questionEs: "Se te cae un vaso de hielo en la estación de boba. El letrero de precaución más cercano está atrás. ¿Qué haces?",
                    options: [
                        { id: "a", textEn: "Run to the back for the sign — it only takes a minute", textEs: "Corres atrás por el letrero — solo toma un minuto" },
                        { id: "b", textEn: "Stay at the spot, warn people, and call a coworker to bring the sign", textEs: "Te quedas en el lugar, avisas a la gente y pides a un compañero que traiga el letrero" },
                        { id: "c", textEn: "Kick the ice under the counter and keep working", textEs: "Empujas el hielo debajo del mostrador y sigues trabajando" },
                        { id: "d", textEn: "Tell the cashier about it and go back to your station", textEs: "Le avisas al cajero y regresas a tu estación" }
                    ],
                    correct: "b"
                },
                {
                    id: "m18-q2",
                    questionEn: "When is it OK to leave a wet spot unattended?",
                    questionEs: "¿Cuándo está bien dejar un lugar mojado sin cuidar?",
                    options: [
                        { id: "a", textEn: "As soon as you've told someone about it", textEs: "En cuanto le avisas a alguien" },
                        { id: "b", textEn: "After about five minutes — it's probably dry by then", textEs: "Después de unos cinco minutos — ya debe estar seco" },
                        { id: "c", textEn: "Once the sign is up and the floor is clean and completely dry", textEs: "Cuando el letrero está puesto y el piso está limpio y completamente seco" },
                        { id: "d", textEn: "If it's behind the line where guests can't see it", textEs: "Si está detrás de la línea donde los clientes no lo ven" }
                    ],
                    correct: "c"
                },
                {
                    id: "m18-q3",
                    questionEn: "You are the only person in the building, nobody can hear you, and there's a puddle at the entrance. What's the right move?",
                    questionEs: "Eres la única persona en el local, nadie te puede oír, y hay un charco en la entrada. ¿Cuál es la acción correcta?",
                    options: [
                        { id: "a", textEn: "Block the spot with a chair or tray stand, get the sign fast, come straight back", textEs: "Bloqueas el lugar con una silla o un soporte de bandejas, vas rápido por el letrero y regresas directo" },
                        { id: "b", textEn: "Leave it — you can't be in two places at once", textEs: "Lo dejas — no puedes estar en dos lugares a la vez" },
                        { id: "c", textEn: "Put a napkin over it so people notice the wet spot", textEs: "Le pones una servilleta encima para que la gente note lo mojado" },
                        { id: "d", textEn: "Mop it without a sign and move on with your prep", textEs: "Lo trapeas sin letrero y sigues con tu prep" }
                    ],
                    correct: "a"
                },
                {
                    id: "m18-q4",
                    questionEn: "There's grease on the floor by the fryer. How do you clean it?",
                    questionEs: "Hay grasa en el piso junto a la freidora. ¿Cómo la limpias?",
                    options: [
                        { id: "a", textEn: "Plain water and a mop, then let it air-dry", textEs: "Agua sola y trapeador, y dejas que se seque solo" },
                        { id: "b", textEn: "Lay cardboard over it until close so nobody steps in it", textEs: "Le pones cartón encima hasta el cierre para que nadie lo pise" },
                        { id: "c", textEn: "Sign up, soak it up, degreaser and mop, then dry it", textEs: "Letrero, absorbes, desengrasante y trapeador, y luego secas" },
                        { id: "d", textEn: "Sprinkle salt on it and keep cooking through the rush", textEs: "Le echas sal y sigues cocinando durante el rush" }
                    ],
                    correct: "c"
                },
                {
                    id: "m18-q5",
                    questionEn: "Who takes the caution sign down?",
                    questionEs: "¿Quién quita el letrero de precaución?",
                    options: [
                        { id: "a", textEn: "Whoever walks by it first once it looks dry", textEs: "El primero que pase cuando ya se vea seco" },
                        { id: "b", textEn: "The person who cleaned it, after checking it's completely dry", textEs: "La persona que limpió, después de revisar que está completamente seco" },
                        { id: "c", textEn: "The Shift Lead, during the closing walk-through", textEs: "El líder de turno, durante el recorrido de cierre" },
                        { id: "d", textEn: "A guest who needs to get through to their table", textEs: "Un cliente que necesita pasar a su mesa" }
                    ],
                    correct: "b"
                },
                {
                    id: "m18-q6",
                    questionEn: "A guest slips on water near a table. What do you do FIRST?",
                    questionEs: "Un cliente se resbala con agua cerca de una mesa. ¿Qué haces PRIMERO?",
                    options: [
                        { id: "a", textEn: "Help them up quickly so the other guests don't notice", textEs: "Lo levantas rápido para que los demás clientes no se den cuenta" },
                        { id: "b", textEn: "Clean up the water before anyone else sees it", textEs: "Limpias el agua antes de que alguien más la vea" },
                        { id: "c", textEn: "Offer a free drink and go back to your station", textEs: "Ofreces una bebida gratis y regresas a tu estación" },
                        { id: "d", textEn: "Stay with them, call for the Shift Lead, keep the spot guarded", textEs: "Te quedas con la persona, llamas al líder de turno y sigues cuidando el lugar" }
                    ],
                    correct: "d"
                },
                {
                    id: "m18-q7",
                    questionEn: "Which of these does NOT need the full guard-and-sign rule?",
                    questionEs: "¿Cuál de estos NO necesita la regla completa de cuidar y poner letrero?",
                    options: [
                        { id: "a", textEn: "Ice on the floor at the boba station", textEs: "Hielo en el piso de la estación de boba" },
                        { id: "b", textEn: "Plain water behind the line, where everyone wears non-slip shoes", textEs: "Agua sola detrás de la línea, donde todos usan zapatos antiderrapantes" },
                        { id: "c", textEn: "Grease on the kitchen floor by the fryer", textEs: "Grasa en el piso de la cocina junto a la freidora" },
                        { id: "d", textEn: "Rain water inside the front door", textEs: "Agua de lluvia adentro de la puerta de entrada" }
                    ],
                    correct: "b"
                },
                {
                    id: "m18-q8",
                    questionEn: "A glass breaks right next to the open ice bin. What happens to the ice?",
                    questionEs: "Se rompe un vaso justo al lado del depósito de hielo abierto. ¿Qué pasa con el hielo?",
                    options: [
                        { id: "a", textEn: "Scoop out the top layer where the glass might be", textEs: "Sacas la capa de arriba donde pudo caer el vidrio" },
                        { id: "b", textEn: "Keep using it — glass sinks to the bottom", textEs: "Lo sigues usando — el vidrio se va al fondo" },
                        { id: "c", textEn: "Dump it all, wash and sanitize the bin, refill", textEs: "Lo tiras todo, lavas y sanitizas el depósito, y lo llenas de nuevo" },
                        { id: "d", textEn: "Pick through it carefully with gloves on", textEs: "Lo revisas con cuidado con guantes puestos" }
                    ],
                    correct: "c"
                }
            ]
        }
    }
];

// Legacy export — keeps any imports of the old name working until the
// renderer migration in the next commit.
export const TRAINING_MODULES = MODULES;
