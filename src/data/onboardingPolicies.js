// Default policy text for the acknowledgment-kind onboarding docs.
//
// These are the templates that ship with the app. Admin can override
// any of them by writing to /config/policies/{key} in Firestore via
// the Templates tab (PoliciesEditor — separate component). The
// acknowledgment renderer loads the override if present, falls back
// to these defaults.
//
// ⚠️ Have a lawyer review the final text before relying on it for
// compliance. These are STARTING points based on:
//   - Missouri at-will + tip credit (Sec. 290.502)
//   - FLSA tip credit written-notice requirement
//   - MO workers' comp written-notice requirement
//   - Generic anti-harassment / EEOC-aligned policy
// They are NOT a substitute for legal review of your specific
// operation, especially around tip pooling, scheduling pay, and any
// county/city ordinances in Webster Groves / Maryland Heights.

export const DEFAULT_POLICIES = {
    handbook: {
        en: {
            title: 'DD Mau Employee Handbook — Summary & Acknowledgment',
            body: `WELCOME TO DD MAU

This handbook covers the basics of working at DD Mau. Read each section. Ask your manager about anything that isn't clear. By signing below, you confirm you've read and understood these policies.

AT-WILL EMPLOYMENT
Your employment with DD Mau is at-will. Either you or DD Mau can end the employment relationship at any time, with or without cause or notice. Nothing in this handbook creates a contract for continued employment.

EQUAL OPPORTUNITY + ANTI-HARASSMENT
DD Mau is an equal opportunity employer. We do not discriminate based on race, color, religion, sex (including pregnancy, sexual orientation, or gender identity), national origin, age (40+), disability, genetic information, veteran status, or any other protected category.

We have zero tolerance for harassment of any kind. If you experience or witness harassment, report it to a manager or owner immediately. Reports will be investigated promptly and confidentially. Retaliation against anyone who reports in good faith is strictly prohibited.

ATTENDANCE + SCHEDULING
You're expected to be on time, in uniform, ready to work. If you can't make a shift, give your manager as much notice as possible — minimum 4 hours for opening shifts. Three no-call-no-shows in a 90-day window may result in termination.

DRESS + GROOMING
Clean DD Mau shirt or apron. Non-slip closed-toe shoes. Hair restrained. Beard nets if facial hair. No strong fragrance. Jewelry minimal (no rings on hands while working). Phones in pockets, silent.

FOOD SAFETY
You'll complete a ServSafe Food Handler course in your first week (we cover the cost). Wash hands before starting any shift, after every break, after handling raw protein, after touching your face. Cross-contamination kills businesses — we take it seriously.

ALCOHOL + DRUGS
Reporting to work under the influence of alcohol or illegal drugs is grounds for immediate termination. Prescription drugs are fine; tell your manager if any prescription affects your ability to work safely.

CASH + INVENTORY
Theft of any kind — cash, food, supplies, time on the clock — results in termination and may be reported to police. We trust you; please don't make us regret it.

CONFIDENTIALITY
Recipes, supplier relationships, pricing, customer information, and operational details are confidential. Don't share with competitors or post on social media.

SOCIAL MEDIA
You're free to have personal social media. Don't post photos of customers, the back-of-house, or DD Mau's confidential information. Don't speak for DD Mau without permission.

INJURIES
Report any work injury to a manager IMMEDIATELY, no matter how small. Missouri workers' comp covers eligible injuries — see the separate Workers' Comp notice.

PAY + TIPS
Pay periods are bi-weekly. Direct deposit is standard. See the separate Tip Credit / Pay Notice for details on your wage and how tips work.

CHANGES TO THIS HANDBOOK
DD Mau may update this handbook at any time. We'll notify you of material changes. By continuing to work after a change is communicated, you agree to the updated policies.

ACKNOWLEDGMENT
I have read this handbook. I understand the policies. I agree to follow them as a condition of my employment. I understand that my employment is at-will and that this handbook is not a contract.`,
        },
        es: {
            title: 'Manual del Empleado de DD Mau — Resumen y Reconocimiento',
            body: `BIENVENIDO A DD MAU

Este manual cubre lo básico de trabajar en DD Mau. Lee cada sección. Pregúntale a tu gerente lo que no esté claro. Al firmar abajo, confirmas que leíste y entendiste estas políticas.

EMPLEO A VOLUNTAD
Tu empleo con DD Mau es a voluntad. Tú o DD Mau pueden terminar la relación laboral en cualquier momento, con o sin causa o aviso. Nada en este manual crea un contrato de empleo continuo.

IGUALDAD DE OPORTUNIDADES Y ANTI-ACOSO
DD Mau es un empleador de igualdad de oportunidades. No discriminamos por raza, color, religión, sexo (incluyendo embarazo, orientación sexual o identidad de género), origen nacional, edad (40+), discapacidad, información genética, estatus de veterano u otra categoría protegida.

Tenemos cero tolerancia al acoso de cualquier tipo. Si experimentas o presencias acoso, repórtalo a un gerente o dueño inmediatamente. Las denuncias se investigarán pronta y confidencialmente. Las represalias contra quien reporta de buena fe están estrictamente prohibidas.

ASISTENCIA Y HORARIOS
Se espera que llegues a tiempo, en uniforme, listo para trabajar. Si no puedes cubrir un turno, avísale a tu gerente lo antes posible — mínimo 4 horas para turnos de apertura. Tres faltas sin avisar en 90 días pueden resultar en despido.

VESTIMENTA
Camiseta de DD Mau o delantal limpio. Zapatos cerrados antideslizantes. Cabello recogido. Redes para barba si aplica. Sin perfume fuerte. Joyería mínima (sin anillos en las manos al trabajar). Teléfonos en el bolsillo, en silencio.

SEGURIDAD ALIMENTARIA
Completarás el curso ServSafe en tu primera semana (cubrimos el costo). Lávate las manos al iniciar turno, después de cada descanso, después de tocar proteína cruda, después de tocarte la cara. La contaminación cruzada arruina negocios — la tomamos en serio.

ALCOHOL Y DROGAS
Reportarte al trabajo bajo la influencia de alcohol o drogas ilegales es causa de despido inmediato. Las recetas médicas están bien; avísale a tu gerente si alguna receta afecta tu capacidad de trabajar con seguridad.

EFECTIVO E INVENTARIO
Robo de cualquier tipo — efectivo, comida, suministros, tiempo en el reloj — resulta en despido y puede reportarse a la policía. Confiamos en ti; por favor no nos hagas arrepentirnos.

CONFIDENCIALIDAD
Recetas, relaciones con proveedores, precios, información de clientes y detalles operativos son confidenciales. No los compartas con la competencia ni los publiques en redes sociales.

REDES SOCIALES
Tienes derecho a redes sociales personales. No publiques fotos de clientes, de la cocina o información confidencial de DD Mau. No hables en nombre de DD Mau sin permiso.

LESIONES
Reporta cualquier lesión laboral a un gerente INMEDIATAMENTE, no importa qué tan pequeña. El seguro de compensación laboral de Missouri cubre lesiones elegibles — ver el aviso separado.

PAGO Y PROPINAS
Los períodos de pago son cada dos semanas. El depósito directo es estándar. Ver el Aviso de Crédito por Propinas para detalles sobre tu salario y cómo funcionan las propinas.

CAMBIOS A ESTE MANUAL
DD Mau puede actualizar este manual en cualquier momento. Te notificaremos de cambios importantes. Al continuar trabajando después de un cambio comunicado, aceptas las políticas actualizadas.

RECONOCIMIENTO
He leído este manual. Entiendo las políticas. Me comprometo a seguirlas como condición de mi empleo. Entiendo que mi empleo es a voluntad y que este manual no es un contrato.`,
        },
    },
    tip_credit: {
        en: {
            title: 'Tip Credit / Pay Notice (FLSA Section 3(m))',
            body: `WAGE NOTICE FOR TIPPED EMPLOYEES

Federal law (Fair Labor Standards Act Section 3(m)) requires us to give you written notice about how your pay works before we can take a tip credit. Read this carefully.

YOUR DIRECT CASH WAGE
DD Mau will pay you a direct cash wage as stated in your offer letter, plus tips. The cash wage may be less than the standard minimum wage if you regularly receive tips; the difference is called the "tip credit."

THE TIP CREDIT
We are taking advantage of the tip credit allowed under federal and Missouri law. The amount of the tip credit we claim per hour, when combined with your direct cash wage, must equal at least the applicable minimum wage. As of this writing, the Missouri minimum wage is $13.75/hour (verify current rate — adjusts annually).

If your tips plus your direct cash wage do not equal at least the minimum wage for any pay period, DD Mau will make up the difference.

TIPS BELONG TO YOU
All tips you receive belong to you. We do not require tip pooling in a way that would include managers, owners, or non-tipped back-of-house employees (kitchen staff who don't customarily and regularly receive tips). Any tip pooling among tipped employees is voluntary and follows federal rules.

CREDIT/DEBIT CARD TIPS
Tips left on credit or debit cards are paid to you in your next paycheck (or earlier if practical). If a processing fee applies to the card transaction, we may deduct the proportional share of that fee from the tip, as allowed by law.

TIPS REPORTED FOR TAXES
You're responsible for accurately reporting tip income to DD Mau and to the IRS. We'll provide a system for reporting tips and will withhold applicable taxes.

OVERTIME
If you work more than 40 hours in a workweek, overtime is calculated based on the FULL minimum wage (not just your direct cash wage), per FLSA rules.

NO CONFISCATION
DD Mau will not require you to give us any portion of your tips, except in compliance with a valid tip pool among tipped employees.

YOUR RIGHTS
If you believe the tip credit is being misapplied, contact a manager or owner. You also have the right to contact the U.S. Department of Labor (Wage and Hour Division) or the Missouri Department of Labor.

ACKNOWLEDGMENT
I have read this notice. I understand my cash wage rate, how tips are handled, and that DD Mau will make up the difference if tips don't bring me to the applicable minimum wage. I understand that all tips I receive belong to me, subject to lawful tip pooling.`,
        },
        es: {
            title: 'Aviso de Crédito por Propinas / Salario (FLSA Sección 3(m))',
            body: `AVISO DE SALARIO PARA EMPLEADOS QUE RECIBEN PROPINAS

La ley federal (FLSA Sección 3(m)) requiere que te demos aviso por escrito sobre cómo funciona tu pago antes de tomar un "crédito por propinas". Lee con cuidado.

TU SALARIO EN EFECTIVO
DD Mau te pagará un salario directo en efectivo según tu carta de oferta, más propinas. El salario en efectivo puede ser menor que el salario mínimo estándar si recibes propinas regularmente; la diferencia se llama "crédito por propinas".

EL CRÉDITO POR PROPINAS
Estamos usando el crédito por propinas permitido por ley federal y de Missouri. El monto del crédito por propinas más tu salario en efectivo debe igualar al menos el salario mínimo aplicable. Al momento de escribir esto, el salario mínimo de Missouri es $13.75/hora (verifica la tasa actual — se ajusta anualmente).

Si tus propinas más tu salario en efectivo no igualan al menos el salario mínimo en algún período de pago, DD Mau cubrirá la diferencia.

LAS PROPINAS SON TUYAS
Todas las propinas que recibes son tuyas. No requerimos un fondo común de propinas que incluya gerentes, dueños o empleados de cocina que normalmente no reciben propinas. Cualquier fondo común entre empleados que reciben propinas es voluntario y sigue las reglas federales.

PROPINAS DE TARJETA
Las propinas dejadas en tarjetas de crédito o débito se te pagan en tu próximo cheque. Si aplica una tarifa de procesamiento, podemos deducir la parte proporcional de la propina, según lo permitido por ley.

REPORTE DE PROPINAS PARA IMPUESTOS
Eres responsable de reportar con exactitud el ingreso por propinas a DD Mau y al IRS. Te daremos un sistema para reportar propinas y retendremos los impuestos aplicables.

HORAS EXTRA
Si trabajas más de 40 horas en una semana laboral, las horas extra se calculan con el salario mínimo COMPLETO (no solo tu salario en efectivo), según las reglas de FLSA.

NO CONFISCACIÓN
DD Mau no te exigirá que nos des ninguna parte de tus propinas, excepto en cumplimiento con un fondo válido entre empleados que reciben propinas.

TUS DERECHOS
Si crees que el crédito por propinas se está aplicando mal, contacta a un gerente o dueño. También tienes derecho a contactar al Departamento de Trabajo de EE.UU. (Wage and Hour) o al Departamento de Trabajo de Missouri.

RECONOCIMIENTO
He leído este aviso. Entiendo mi salario en efectivo, cómo se manejan las propinas y que DD Mau cubrirá la diferencia si las propinas no me llevan al salario mínimo aplicable. Entiendo que todas las propinas que recibo son mías, sujetas a fondos comunes legales.`,
        },
    },
    workers_comp: {
        en: {
            title: 'Missouri Workers\' Compensation Notice',
            body: `WORKERS' COMPENSATION RIGHTS — MISSOURI

Missouri law requires DD Mau to give you written notice about your workers' compensation rights. Read this and keep it for your records.

WHAT IS WORKERS' COMP?
Workers' compensation is a no-fault insurance system that covers most employees who are injured on the job or develop a work-related illness. It pays for medical treatment and a portion of lost wages while you recover.

WHO IS COVERED
All DD Mau employees are covered from your first day of work. You don't need to do anything to enroll — coverage is automatic.

WHAT IS COVERED
- Injuries that happen at work or during work-related activities
- Occupational diseases caused by work (e.g. repetitive strain, work-related burns)
- Medical bills, including doctor visits, hospital stays, prescriptions, physical therapy
- Temporary total disability (lost wages while you can't work)
- Permanent disability if applicable
- Death benefits for dependents in the event of a fatal injury

WHAT YOU MUST DO IF INJURED
1. Report the injury to your manager or a DD Mau owner IMMEDIATELY. By law, you must report within 30 days; reporting same-day helps your claim and your recovery.
2. Get medical attention. For emergencies, call 911 or go to the nearest ER. For non-emergencies, your manager will direct you to an approved provider.
3. Tell the medical provider the injury is work-related so workers' comp is billed, not your personal insurance.
4. Cooperate with the investigation. Provide statements, records, and follow medical advice.

YOUR RIGHTS
- You have the right to receive workers' comp benefits as required by law without fear of retaliation.
- You have the right to be represented by an attorney in workers' comp matters at your own expense.
- You have the right to contact the Missouri Division of Workers' Compensation if you believe your claim is being mishandled.

CONTACT FOR THE INSURANCE CARRIER
Ask any manager or owner for the current workers' comp carrier and policy number. We'll post the official poster in the back of house as required by law.

MISSOURI DIVISION OF WORKERS' COMPENSATION
P.O. Box 58
Jefferson City, MO 65102
800-775-2667 · labor.mo.gov/dwc

REPORTING FRAUD
Workers' comp fraud — by an employee, employer, or provider — is a crime. Report suspected fraud to the Missouri Department of Insurance.

ACKNOWLEDGMENT
I have received and read this notice. I understand my rights and what I need to do if I get injured at work. I will report any work-related injury to a manager immediately.`,
        },
        es: {
            title: 'Aviso de Compensación Laboral de Missouri',
            body: `DERECHOS DE COMPENSACIÓN LABORAL — MISSOURI

La ley de Missouri requiere que DD Mau te dé aviso por escrito sobre tus derechos de compensación laboral. Lee esto y guárdalo.

¿QUÉ ES LA COMPENSACIÓN LABORAL?
La compensación laboral es un sistema de seguro sin culpa que cubre a la mayoría de empleados que se lesionan en el trabajo o desarrollan una enfermedad relacionada con el trabajo. Paga tratamiento médico y una parte del salario perdido mientras te recuperas.

QUIÉN ESTÁ CUBIERTO
Todos los empleados de DD Mau están cubiertos desde su primer día de trabajo. No necesitas hacer nada para inscribirte — la cobertura es automática.

QUÉ SE CUBRE
- Lesiones que ocurren en el trabajo o durante actividades laborales
- Enfermedades ocupacionales causadas por el trabajo
- Cuentas médicas, incluyendo doctor, hospital, recetas, fisioterapia
- Discapacidad temporal total (salario perdido mientras no puedes trabajar)
- Discapacidad permanente si aplica
- Beneficios por muerte para dependientes en caso de lesión fatal

QUÉ DEBES HACER SI TE LESIONAS
1. Reporta la lesión a tu gerente o a un dueño de DD Mau INMEDIATAMENTE. Por ley, debes reportar dentro de 30 días; reportar el mismo día ayuda tu reclamo y tu recuperación.
2. Busca atención médica. Para emergencias, llama al 911 o ve a la sala de emergencias más cercana. Para no-emergencias, tu gerente te dirigirá a un proveedor aprobado.
3. Dile al proveedor médico que la lesión es relacionada al trabajo para que cobren al seguro de compensación laboral, no a tu seguro personal.
4. Coopera con la investigación. Provee declaraciones, registros y sigue el consejo médico.

TUS DERECHOS
- Tienes derecho a recibir beneficios sin miedo a represalias.
- Tienes derecho a ser representado por un abogado en asuntos de compensación laboral a tu propio costo.
- Tienes derecho a contactar a la División de Compensación Laboral de Missouri si crees que tu reclamo se está manejando mal.

CONTACTO DE LA ASEGURADORA
Pídele a cualquier gerente o dueño el seguro actual y número de póliza. Publicaremos el cartel oficial en la cocina según la ley.

DIVISIÓN DE COMPENSACIÓN LABORAL DE MISSOURI
P.O. Box 58
Jefferson City, MO 65102
800-775-2667 · labor.mo.gov/dwc

REPORTAR FRAUDE
El fraude de compensación laboral — por un empleado, empleador o proveedor — es un crimen. Reporta sospechas de fraude al Departamento de Seguros de Missouri.

RECONOCIMIENTO
He recibido y leído este aviso. Entiendo mis derechos y qué hacer si me lesiono en el trabajo. Reportaré cualquier lesión laboral a un gerente inmediatamente.`,
        },
    },
};
