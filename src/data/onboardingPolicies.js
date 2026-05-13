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
            title: 'DD Mau Employee Handbook',
            body: `INTRODUCTION

What you'll need to know about DD Mau Vietnamese Eatery.

When one enters any of the DD Mau restaurants, it is important that it is operated in the same manner. If a customer visits two different DD Mau restaurants, they should expect to receive the same quality of food and service. This is what we strive for.

DD MAU VISION STATEMENT
Reinvent the idea of fresh, healthy and vibrant tasty Vietnamese food. We strive for perfection and ensure quality in every dish.

WHAT WE WORK TOWARDS
The most important part of any service business is the people. We welcome customers when they enter and guide them through the entire experience. Customers frequently go to places where they are welcome.

DD Mau is about offering wholesome, Vietnamese food made with the freshest ingredients. Fresh product and a clean store are very important in maintaining a good image and gaining new customers. Consistency plays a major part as well.

WELCOME LETTER

Welcome to our team!

Welcome to DD MAU. We look forward to the opportunity to work with you and want you to know that we recognize our employees as our most valuable resource. Our continued success in providing the highest quality of food, beverages, and service to our customers depends on having quality people like yourself and your fellow employees. We want you to enjoy your time here and are committed to helping you succeed in your new job.

We have prepared this handbook to answer some of the questions that you may have concerning DD MAU and its policies. This handbook is intended solely as a guide. Please, read it thoroughly. If you have questions about anything, contact your supervisor for assistance.

We hope you find your time with us to be an enjoyable and rewarding experience.

Sincerely,
Julie

ABOUT THIS HANDBOOK

This handbook is designed to help you get familiarized with DD MAU. We want you to understand how we do business and how important you and every employee is in helping us take care of our guests and making this a fun and rewarding place to work.

The policies stated in this handbook may change from time to time. It isn't flawless either. We've done our best to include as much information as possible in an easy-to-understand manner.

This handbook is not a contract, which guarantees your employment for any specific time. Either you or DD MAU may terminate your employment at any time, for any reason, with or without cause or notice. Understand that no supervisor, manager, or representative of DD MAU, other than Julie, has the authority to enter into any agreement with you for employment for any specified period or to make any such promises or commitments.

We wish you the best of luck in your position and hope that your employment with DD MAU will be a very enjoyable and rewarding experience.

EMPLOYMENT POLICIES

Hiring
It is DD MAU's policy to hire only United States citizens and aliens who are authorized to work in this country. As required by law, employees will be required to provide original documents that establish this authorization within three (3) days of their date of hire. If the documents are not provided within this three day period, we have no choice, under the law, but to terminate the employee until the appropriate documents are provided. Employees and employers are both required to complete a form furnished by the Department of Labor, form I-9. In Section 1 of form I-9, the information provided by the employee must be valid and authentic. If at any time during an employee's employment, it is discovered that any document used was invalid or not authentic, the employee must, by law, be immediately terminated.

Non-Discrimination
DD MAU is an equal opportunity employer. We will not tolerate discrimination based on race, sex, age, national origin, religion, sexual orientation, gender identity, or disability. Employment decisions, such as hiring, promotion, compensation, training and discipline will be made only for legitimate business reasons based upon qualifications and other non-discriminatory factors.

Age Requirements
All employees, as per the law, must be at least 18 years of age. Employees under the age of 18 must comply with all federal wage and hour guidelines, no exceptions. The required work permits must be supplied when applicable. No employees under the age of 18 years can take orders for or serve alcoholic beverages.

Orientation Period
You have been through our employee selection process, have been selected for employment and appear to have the potential to develop into a successful employee. However, we want the opportunity to begin the training period; we would like to get to know you to see how you fit in with your co-workers and determine if you are willing and able to carry out the responsibilities for the position in which you were hired. It's also important for you to get to know us and become familiar with how we operate to find out if this job is a good fit for you. We, therefore, have a 2 week Orientation Period for that purpose. The 2 week period allows both you and DD MAU to see whether or not it's a good fit and if not, part ways as friends. During the Orientation Period you will begin your training and be observed by management. Also, during this time if you feel you do not understand what's expected of you or that you need additional training, we encourage you to ask questions and seek additional help from our management staff.

Evaluations
All employees will be continuously evaluated. Each shift is a learning opportunity to improve. Understand that feedback is given in real time and written evaluations may be given periodically, but will not be regular.

The evaluation process is an opportunity to identify accomplishments and strengths as well as openly discuss areas and goals for any improvement. Depending on your position and performance, you may be eligible for a pay increase. Pay increases are not guaranteed. Rewards are based solely on a person's job performance and results.

Schedules
Schedules are prepared to meet the work demands of the restaurant. As the work demands change, management reserves the right to adjust working hours and shifts. Schedules are posted weekly (11:59PM Saturday). Each employee is responsible for working their shifts. Please have unavailability and time off in by Wednesday for Saturday's schedule.

You should arrive for your shift with enough time to make sure you're ready to work when your shift begins. We suggest that you arrive 5 to 10 minutes before your shift begins so that you have time to get settled and ready for your shift. You should clock in when your shift begins and be ready to start work immediately.

Schedule changes may be allowed only if you find a replacement and get a manager's approval. To be valid, the manager must indicate the change on the Sling system. The restaurant usually requires high levels of staff on or around holidays, sporting events, and other special events for the area. We understand that you have a life outside of the restaurant and will always try to find a way to work with you on your schedule requests. We do, however, ask you to remember just how crucial each position is to the proper functioning of the restaurant. Please remember that even though we will try to comply with your requests, there is no assurance that you will get the requested time off.

STANDARDS OF CONDUCT

Consistent with our values, it is important for all employees to be fully aware of the rules which govern our conduct and behavior. In order to work together as a team and maintain an orderly, productive, and positive working environment, everyone must conform to standards of reasonable conduct and policies of the Restaurant. AN EMPLOYEE INVOLVED IN ANY OF THE FOLLOWING CONDUCT MAY RESULT IN DISCIPLINARY ACTION UP TO AND INCLUDING IMMEDIATE TERMINATION WITHOUT A WRITTEN WARNING.

 1. Invalid Work Authorization (I-9 form).
 2. Supplying false or misleading information to DD MAU, including information at the time of application for employment, leave of absence, or sick pay.
 3. Not showing up for a shift without notifying the Manager on duty. The first instance is a fireable offense. Management reserves the right to make a determination on an individual case basis (No call, no show, no job).
 4. Clocking another employee "in" or "out" on the DD MAU timekeeping system or having another employee clock you either "in" or "out."
 5. Leaving your job before the scheduled time without the permission of the Manager on duty.
 6. Arrest or conviction of a felony offense without disclosing this to management in writing.
 7. Use of foul or abusive language.
 8. Disorderly or indecent conduct.
 9. Gambling on DD MAU property.
10. Theft of customer, employee, or DD MAU property. This includes any items found on DD MAU premises and presumed to be lost. Proper procedure is to turn it in to management. Management will hold the found property.
11. Theft, dishonesty or mishandling of DD MAU funds. Failure to follow cash or credit card processing procedures.
12. Refusal to follow instructions.
13. Engaging in harassment of any kind toward a customer or another employee.
14. Failure to consistently perform job responsibilities in a satisfactory manner within the 30 day orientation period.
15. Use, distribution, or possession of illegal drugs on DD MAU property or being under the influence of these substances when reporting to work or during work hours.
16. Waste or destruction of DD MAU property.
17. Actions or threats of violence or abusive language directed toward a customer or another staff member.
18. Excessive tardiness (more than 15 minutes late).
19. Habitual failure to punch in or out.
20. Disclosing confidential information including policies, procedures, recipes, manuals or any proprietary information to anyone outside of DD MAU.
21. Rude or improper behavior with customers including the discussion of tips.
22. Smoking or eating in unapproved areas or during unauthorized breaks.
23. Not parking in employee designated parking area.
24. Failure to comply with DD MAU's personal cleanliness and grooming standards.
25. Failure to comply with DD MAU's uniform and dress requirements.
26. Unauthorized operation, repair, or attempt to repair, machines, tools, or equipment.
27. Failure to report safety hazards, equipment defects, accidents, or injuries, immediately to management.
28. Excessive call-ins. Failure to fulfill your shift obligations regardless of notification to a manager.

DRUG AND ALCOHOL POLICY

DD MAU is committed to providing a safe and productive work environment for its employees and patrons. Alcohol and drug abuse pose a threat to the health and safety of fellow employees and patrons, and to the security of our equipment and facilities. For these reasons, DD MAU is committed to the elimination of drug and/or alcohol use and abuse in the workplace.

This policy outlines the practice and procedure designed to correct instances of identified alcohol and/or drug use in the workplace. For the purpose of this policy and its enforcement, "drugs" are classified as any drug that's illegal under federal, state, or local law and/or any drug that is illegal under the federal Controlled Substances Act. This policy applies to all employees and all applicants for employment of DD MAU.

Drug-Free and Alcohol-Free Workplace
Employees should report to work fit for duty and free of any adverse effects of illegal drugs or alcohol. This policy does not prohibit employees from the lawful use and possession of prescribed medications. Employees must, however, consult with their doctors about the medications' effect on their fitness for duty and their ability to work safely. Promptly disclose any work restrictions to your supervisor. Employees should not, however, disclose underlying medical conditions to managers, unless directed to do so by their doctor.

Work Rules
 - Illegal drugs are defined in this policy to include: cocaine, ecstasy, hallucinogens, amphetamines, steroids, heroin, PCP, marijuana and other substances that are illegal in Missouri.
 - Using marijuana for medical or recreational reasons, marijuana in the workplace is not allowed. An employee is not permitted to be under the influence of marijuana while working.
 - Whenever employees are working, operating any company vehicle, are present on company premises, or are conducting related work off-site, they are prohibited from using, possessing, buying, selling, manufacturing, or dispensing an illegal drug (to include possession of drug paraphernalia); or being under the influence of alcohol or an illegal drug as defined in this policy.
 - The presence of any detectable amount of any illegal drug or illegal controlled substance in an employee's body while performing company business or while in a company facility is prohibited.
 - DD MAU will not allow any employee to perform their duties while taking prescribed drugs that are adversely affecting the employee's ability to safely and effectively perform their job duties. Employees taking a prescribed medication must carry it in the container labeled by a licensed pharmacist or be prepared to produce it if asked before their next scheduled shift.
 - Any illegal drugs or drug paraphernalia will be turned over to an appropriate law enforcement agency and may result in criminal prosecution.

Required Testing
The company retains the right to require the following tests:
 - Reasonable suspicion: Employees may be subjected to testing based on observations by a supervisor of apparent workplace use, possession, or impairment.
 - Post-accident: Employees may be subjected to testing when they cause or contribute to accidents that seriously damage a company vehicle, machinery, equipment or property and/or result in an injury to themselves or another employee requiring off-site medical attention. In any of these instances, the investigation and subsequent testing may be scheduled within two (2) hours following the accident, if not sooner.

Inspections
DD MAU reserves the right to inspect all portions of its premises for drugs, alcohol, or other contraband. All employees and visitors may be asked to cooperate in inspections of their persons, work areas, and property that might conceal a drug, alcohol, or other contraband. Employees who possess such contraband or refuse to cooperate in such inspections are subject to appropriate discipline up to and including discharge.

Crimes Involving Drugs
DD MAU prohibits all employees from manufacturing, distributing, dispensing, possessing, or using an illegal drug in or on company premises or while conducting company business. Employees are also prohibited from misusing legally prescribed or over-the-counter (OTC) drugs. Law enforcement personnel shall be notified, as appropriate, when criminal activity is suspected.

Marijuana Use
DD MAU is committed to ensuring a safe, healthy, and productive work environment for all employees. Using marijuana in the workplace hurts productivity and poses a danger to everyone. For these reasons, DD MAU prohibits the use of marijuana in the workplace. Compliance with this policy is a condition of continued employment for all employees. DD MAU complies with all state and federal laws and regulations regarding marijuana use. This policy addresses the prohibition against using marijuana in the workplace.

Prohibited Conduct
Employees are prohibited from reporting to work or working while under the influence of marijuana, which can adversely affect their ability to safely and effectively perform their job duties. Employees are further prohibited from consuming, smoking, or otherwise ingesting marijuana before work hours, during work hours, including during meal and rest breaks. DD MAU doesn't accommodate the medical use of marijuana in the workplace. Employees, including state-authorized medical marijuana users, are prohibited from using marijuana while at work.

Violations of Employer's Marijuana Use Policy
Employees who fail to comply with DD MAU's marijuana use policy are subject to discipline, required testing, also up to and including termination.

HARASSMENT

It is DD MAU's policy to treat all personnel with dignity and respect and make personnel decisions without regard to race, sex, age, color, national origin, religion, sexual orientation, gender identity, or disability. We strive to provide everyone a workplace that is free of harassment of any kind. Employees are encouraged to promptly report incidences of harassment.

Sexual Harassment
DD MAU is committed to providing a work environment that is free from all forms of discrimination and conduct that can be considered harassing, abusive, coercive, or disruptive, including sexual and other types of harassment. Actions, words, jokes, or comments based on an individual's sex, race, color, national origin, age, religion, disability, pregnancy, sexual orientation, gender identity, gender expression, veteran status, military duty, genetic information, or any other legally protected characteristic will not be tolerated.

All employees, including hourly employees, members of management, and executives, are prohibited from engaging in harassment of any type. DD MAU will also take appropriate steps to ensure that its employees are not subjected to harassment by guests, vendors, or members of the public. Harassment will not be tolerated and will result in disciplinary action, up to and including immediate termination of employment. Non-employee violators of this policy are subject to expulsion from DD MAU facilities.

Definition of Sexual Harassment
Harassment based on a legally protected characteristic is unlawful discrimination and is illegal under federal law and many state and local laws. Harassment is a pattern of physical and/or verbal conduct that a reasonable employee would find intimidating, undesirable, or offensive and has the purpose or effect of interfering with an employee's work performance or creates an intimidating, hostile, or offensive work environment. All harassment is prohibited regardless of whether it takes place on the premises or outside, including at social events, business trips, training sessions or other company sponsored events.

The types of conduct that are prohibited by this policy and that may constitute harassment include but are not limited to the following:
 - Verbal conduct such as epithets, derogatory comments, foul or obscene language, jokes, nicknames, slurs, taunts, threats.
 - Visual conduct such as derogatory or otherwise offensive posters, cards, calendars, photographs, cartoons, graffiti, drawings, or gestures.
 - Physical conduct such as assault, unwelcome touching, blocking normal movement, or interfering with work.

Sexual harassment includes unwelcome sexual advances, requests for sexual favors and other verbal or physical conduct of a sexual nature, when:
 - Submission to such conduct is made either explicitly or implicitly a term or condition of an individual's employment; or
 - Submission to or rejection of such conduct by an individual is used as the basis for employment decisions affecting such individuals; or
 - Such conduct has the purpose or effect of unreasonably interfering with an individual's work performance or creating an intimidating, hostile or offensive work environment.

Sexual harassment may include individuals of the same or different genders. Specific examples include:
 - Unwelcome sexual advances or propositions, requests for sexual favors, flirtation, sexually-suggestive gestures, whistling, or leering.
 - Unwanted physical contact, including patting, pinching, kissing, grabbing, hugging, brushing up against another person, or inappropriate touching.
 - Physical violence, including sexual assault.
 - Sexual jokes, teasing, sexually suggestive noises, comments about appearance or an employee's personal life, or sexual comments or stories.
 - Display of sexually explicit or offensive materials in the workplace, including on a computer, smartphone, by email, or text message.

Reporting Harassment Is Everyone's Responsibility
DD MAU can only remedy harassment which you bring to our attention. To give the Company the opportunity to address and prevent future occurrences of harassment, it is everyone's responsibility to immediately report any conduct that they believe may violate this policy, whether they were a victim of the conduct or were only a witness to it. Regardless of whether you are certain that another person's behavior really constitutes "harassment," it is your responsibility to report the behavior as soon as possible. Rarely, if ever, should you wait longer than the next regular business day before reporting conduct that violates this policy.

Procedures for Reporting Harassment Claims
Employees should immediately report the conduct to the manager on duty at the restaurant. If the manager on duty does not timely respond, or if the employee believes it would be inappropriate to report the conduct to that person, the employee should immediately contact the General Manager. If the General Manager does not respond timely or it would be inappropriate to report the conduct to the General Manager, the employee should immediately contact the General Manager's supervisor, Julie.

The availability of these complaint procedures does not preclude individuals who believe they are being subjected to harassing conduct from also promptly advising the offender that his or her behavior is unwelcome and requesting that it be discontinued. Any employee can raise concerns and make reports without fear of reprisal or retaliation.

Investigation of Claims
Your concerns will be investigated promptly, and appropriate remedial action will be taken in the event that it is determined that violations of the policy have occurred. All complaints will be kept in the strictest confidence possible, except as necessary to complete an investigation.

Depending on the nature and circumstance of the harassment, discipline can include, but is not limited to, counseling, suspension without pay, and/or termination of employment. Disciplinary action may also be taken against members of management who know of the behavior occurring, or of a complaint, and who fail to take immediate and appropriate action.

False accusations of harassment can have serious effects on other employees and the culture of the Company. If, after the investigation, it is clear that a complaining employee or a witness who participated in the investigation has maliciously or recklessly made a false accusation, they will be subject to discipline, up to and including termination of employment.

Retaliation Is Prohibited
Any employee who, in good faith, brings a harassment complaint, appears as a witness, or assists in an investigation of such a complaint, serves as an investigator of the complaint, or is associated with another employee who made a complaint, or has participated in the investigation will not be adversely affected in terms of employment or retaliated against or discharged because of the complaint. Complaints of retaliation should be reported immediately using the same complaint procedure set forth above and will be promptly investigated according to the investigation procedures outlined above. Retaliation or threats of retaliation will be grounds for disciplinary action as set forth above, up to and including termination of employment.

ABSENCES

All employees are expected to work on a regular, consistent basis and to complete their regularly scheduled hours per week. Excessive absenteeism may result in disciplinary action, up to and including termination. Disciplinary action taken because of absenteeism will be considered on an individual basis, following a review of the employee's absentee and overall work record.

 - If you are going to miss work, employees are expected to call and talk to a supervisor at least 2 hours before they are scheduled to work. If you are going to the hospital, you need to provide a doctor's note. The manager will determine if the absence is excused or not.
 - Any employee who does not call or report to work for shift (no call no show) will be considered to have voluntarily resigned employment at DD MAU.
 - Prior to taking a leave of absence for purposes of vacation, personal leave, military or jury duty, or other planned absence, a Time Off Request via the Sling app must be submitted as soon as is possible and approved by a supervisor.
 - Time Off Requests should be submitted no later than the Thursday prior to the posting of the work schedule for the scheduled leave dates unless the request is due to an unexpected emergency. The nature of the emergency should then be shared with your supervisor so a determination can be made.
 - To return to work from an accident or medical leave, all employees must present a doctor's release.
 - Any employee who fails to return to work at the expiration of a personal leave of absence will be deemed to have abandoned their job, unless DD MAU is notified of a reason, satisfactory to management, for not returning to work at the end of the leave of absence.

Tardiness
Employees must be prepared to start work promptly at the beginning of the shift. Always arrive at the Restaurant 5 to 10 minutes before your shift. Your scheduled time is the time you are expected to be on your job, not arrive at the Restaurant. Repeated tardiness is grounds for termination. If it is not possible for you to begin work at your scheduled time, you must call the Restaurant and speak to the Manager on duty.

Resignations
You are requested to give a two-week notice of your plans to leave the restaurant. A notice is important so that we have time to hire someone to take your place. Giving a two-week notice is a professional courtesy and assures that you are eligible for re-hire and will not have a "left without resignation notice" on your employment record.

PAYMENT PROCEDURES

Time Clock Procedures
You should arrive at the restaurant 5 to 10 minutes before you are scheduled to start work. Notify the Manager on duty that you have arrived for your shift. You may clock in within 15 minutes of the start of your shift. All hourly employees are given an employee ID number to clock in and out on the Restaurant's timekeeping system.

Tampering, altering, or falsifying time records or recording time on another employee's ID number is not allowed and may result in disciplinary action, up to and including termination.

Tips
DD Mau pays every employee at or above the Missouri minimum wage; we do NOT take a tip credit. Because we pay full minimum wage, federal law lets us run a mandatory tip pool that includes both front-of-house (FOH) and back-of-house (BOH) staff. Owners, managers, and supervisors are excluded from the pool, as required by law.

How the pool works:
 - All tips received during the pay period (cash + credit card) are pooled together.
 - 50% of the pool is allocated to the FOH share, 50% is allocated to the BOH share.
 - The FOH share is divided by the total FOH hours worked during the pay period to produce an FOH dollars-per-hour rate.
 - The BOH share is divided by the total BOH hours worked during the pay period to produce a BOH dollars-per-hour rate.
 - Your portion of the pool = your hours worked on your side x that side's dollars-per-hour rate.

Tip pool earnings are added to your paycheck at the end of each pay period. Credit card tips may be reduced by the proportional processing fee for that transaction, as allowed by law.

You're responsible for accurately reporting tip income to DD Mau and to the IRS. We withhold applicable taxes on reported tips.

Payroll Checks
Paychecks are available at the Restaurant on the Friday the week of payroll of each month during business hours. After payday, you may pick up your paycheck during the same hours. Please understand that it may be difficult for anyone to be available to obtain your paycheck during peak business hours so plan accordingly.

Payroll Deductions
Your paycheck will indicate your gross earnings as well as deductions for federal and state withholding taxes and social security and Medicare taxes. Federal and state withholding taxes are authorized by you based on the information you furnished to us on form W-4. If you want an explanation of your deductions or if you wish to change them in any way, please see your supervisor.

As per state law, DD MAU complies with court orders in connection to garnishments from employee paychecks as directed by the proper authorities. You will be notified of any court-ordered payroll deductions.

Change of Address
We ask that you report any address changes to your supervisor as soon as possible so your year-end statement of income and deductions, form W-2, will be mailed to the correct address.

Lost Paychecks
Report lost paychecks to manager. We will stop payment on the lost check and reissue you another check on the next payroll cycle. The reissued check will incur a deduction equal to the bank stop payment charge.

BENEFITS

Holidays
Due to the nature of the restaurant business you may be required to work holidays. It is currently our policy to close the Restaurant for business on the following holidays: Thanksgiving Day, Christmas Day and Easter Day.

Vacations
Vacations are provided by the Restaurant to enable employees to leave their work environment for a period of time and must be taken within the year in which they are earned.

All full-time employees who have been with the Restaurant for a consecutive 12 month period are eligible for a one week paid vacation. Employees are considered full-time if they averaged over 40 hours of work per week the previous year.

Request forms (Employee Leave Request) for vacation are available from the supervisors and are to be submitted to the employee's immediate supervisor and approved prior to granting vacation leave. Employees are asked to submit requests for vacation at least one month prior to the scheduled vacation date, unless the request is due to an unexpected situation. Efforts will be made to grant vacation time as requested, but business needs may require an employee to adjust his or her vacation time.

Worker's Compensation
Worker's compensation provides benefits for employees who suffer personal injury from accidents or illnesses arising out of, and in the course of, their employment with the Restaurant. An employee who is injured on the job, regardless of the severity of the injury or illness, should:
 - Report the occurrence to the manager on duty.
 - The manager on duty will need to obtain information as to exactly what happened, how the injury or illness occurred, the exact time and location, as well as any witnesses to the occurrence.

If an employee experiences a disabling work injury, the nature of which necessitates an absence from work, the supervisors will provide the employee with information concerning his or her lawful benefits.

Employee Meals
Employees receive a meal during each shift. If you would like to purchase food during your shift, each employee receives a 15% discount. Please limit your purchase to food only for yourself.

EMPLOYEE USE OF SOCIAL MEDIA WEBSITES

While DD MAU encourages its employees to enjoy and make good use of their off-duty time, certain activities on the part of employees may become a problem if they have the effect of impairing the work of any employee; harassing, demeaning, or creating a hostile working environment for any employee; disrupting the smooth and orderly flow of work within the company; directly or indirectly disclosing confidential or proprietary information; or harming the goodwill and reputation of DD MAU among its customers or in the community at large. In the area of social media (print, broadcast, digital, and online), employees may use such media in any way they choose as long as such use does not produce the adverse consequences noted above.

For this reason, DD MAU reminds its employees that the following guidelines apply in their use of social media, both on and off duty:

 1. If an employee publishes any personal information about themselves, another employee of DD MAU, a client, or a customer in any public medium (print, broadcast, digital, or online) that:
    a. has the potential or effect of involving the employee, their co-workers, or DD MAU in any kind of dispute or conflict with other employees or third parties;
    b. interferes with the work of any employee;
    c. creates a harassing, demeaning, or hostile working environment for any employee;
    d. disrupts the smooth and orderly flow of work within the office, or the delivery of services to the company's clients or customers;
    e. harms the goodwill and reputation of DD MAU among its customers or in the community at large;
    f. tends to place in doubt the reliability, trustworthiness, or sound judgment of the person who is the subject of the information; or
    g. reveals proprietary information or DD MAU trade secrets;
    then the employee(s) responsible for such problems may be subject to counseling and/or disciplinary action, up to and potentially including termination of employment, depending upon the circumstances.

 2. No employee of DD MAU may use company equipment or facilities for furtherance of non-work-related activities or relationships without the express advance and written permission of Julie Truong.

 3. Employees who conduct themselves in such a way that their actions and relationships with each other could become the object of gossip among others in the workplace, or cause unfavorable publicity for DD MAU in the community, should be concerned that their conduct may be inconsistent with one or more of the above guidelines. In such a situation, the employees involved should request guidance from Julie to discuss the possibility of a resolution that would avoid such problems. Depending upon the circumstances, failure to seek such guidance may be considered evidence of intent to conceal a violation of the policy and to hinder an investigation into the matter.

 4. Should you decide to create a personal blog, be sure to provide a clear disclaimer that the views expressed in said blog are the author's alone, and do not represent the views of DD MAU.

 5. All information published on any employee blog(s) should comply with DD MAU's confidentiality and disclosure of proprietary data policies. This also applies to comments posted on other social networking sites, blogs and forums.

 6. Be respectful to DD MAU, co-workers, customers, clients, partners and competitors, and be mindful of your physical safety when posting information about yourself or others on any forum. Describing intimate details of your personal and social life, or providing information about your detailed comings and goings might be interpreted as an invitation for further communication - or even stalking and harassment that could prove dangerous to your physical safety.

 7. Social media activities should never interfere with work commitments.

 8. Your online presence can reflect on DD MAU. Be aware that your comments, posts, or actions captured via digital or film images can affect the image of DD MAU.

 9. Do not discuss company clients, customers, or partners without their express consent to do so.

10. Do not ignore copyright laws; cite or reference sources accurately. Remember that the prohibition against plagiarism applies online.

11. Do not use any DD MAU logos or trademarks without written consent. The absence of explicit reference to a particular site does not limit the extent of the application of this policy. If no policy or guideline exists, DD MAU employees should use their professional judgment and follow the most prudent course of action. If you are uncertain, consult your supervisor or manager before proceeding.

RESTAURANT POLICIES AND PRACTICES

Customer Service
Our restaurant exists only because of customers. In particular, repeat customers who voluntarily choose to return here and spend their money on our food and beverages. Without our customers we don't have a restaurant, they are the only reason we are here. As a result, taking care of our customers is our highest priority, in fact a privilege, never an interruption. At DD MAU the customer always comes first!

Customer Complaints
Nobody enjoys being the recipient of customer complaints, but complaints are to be expected as part of being in the hospitality business. Complaints can even be viewed in a positive light if they are handled properly. Complaints can give us insights as to how to make our Restaurant better, demanding customers force us to be our best and resolving complaints satisfactorily can even increase customer loyalty IF they are handled properly.

When faced with a customer complaint:
 - Don't get defensive.
 - Do not try to explain the situation away.
 - Remove the offending item immediately.
 - Apologize for the problem and tell the customer you will take care of the problem.
 - If you need the assistance of a manager, don't hesitate to ask.

Do everything you can to let the customer know you care and that this isn't the kind of experience you want them to have at our restaurant.

Telephone Courtesy
ALL CALLS ON OUR COMPANY PHONES ARE RECORDED.

It is everyone's responsibility to answer the phone. Always answer the phone promptly, within two rings. Always answer in a friendly, polite manner: "Good (morning, afternoon, evening), DD MAU, may I help you?"

Respond to any questions that you are absolutely certain of the answer. If you are uncertain, ask the person if you may put them on hold for a moment and quickly refer the call to a manager. Always thank the person for calling. Always ask the caller for their name when they ask to speak to a manager or customer.

Management / Employee Relations
Our managers are committed and trained to provide you with the tools and positive working environment for you to do your job to the best of your ability with minimal distractions. You will be treated with respect and dignity by all of our management personnel and we will try our best to recognize and reward your hard work and accomplishments.

We recognize there may be occasions for misunderstandings and problems to come up. We want to clear up these types of situations in a fair and timely manner and in order to do this we need your help in bringing them to our attention. We want you to know that management is never too busy to be informed of work-related problems, complaints, or disputes of any employee.

If you have such a problem, you should promptly talk to Julie. They will listen in an open, objective, and courteous manner. We want to understand and solve the problem.

Every necessary action will be taken to resolve a problem or settle a dispute in a fair and equitable manner. As we said in the "Welcome Letter," we recognize our employees as our most valuable resource and we take all employee problems and complaints very seriously. No problem is too small or insignificant and each issue will be given the utmost attention and consideration.

Meetings
Staff meetings are held for your benefit as well as for the Restaurant. Meetings are held for a variety of reasons and can include new menu offerings, upcoming promotions and events, training, policies, etc. Such meetings are treated as a shift, attendance is mandatory and you will be paid accordingly. Only management-approved absences will be accepted. Most meetings offer employees the opportunity to provide valuable input for feedback and provide suggestions to enhance our working environment and the operation of the Restaurant.

Teamwork
We cannot achieve our goals and provide the highest levels of service to our customers without working together as a team. Teamwork basically boils down to common courtesy and common sense. If a co-worker is overloaded and you're not, help them in any way you can. It's only a matter of time before they will return the favor. Pitch in to help a customer whether they are technically yours or not. If another employee hasn't quite caught on to something and you have, ask if you may suggest another way to do it. Genuine teamwork makes for a much more enjoyable and satisfying work experience and results in happier (and more generous) customers.

Communication
It is important for every employee to have a good sense of "what's going on" in the Restaurant. It is management's responsibility to keep everyone informed of ongoing changes and news affecting the Restaurant and our people. Such communication takes place primarily in pre-shift meetings, general meetings, and by posting notices and information to the board located next to the manager's office.

SAFETY

DD MAU is committed to maintaining a safe workplace for all of our employees. The time to be conscious about safety is before an accident happens. Safety is everyone's responsibility and is a regular, ongoing part of everyone's job.

You will receive more specific, detailed information and training on safety issues as an ongoing part of your employment. However, here are some basic guidelines and safety rules to always keep in mind:
 - Wipe up spills immediately.
 - Never run in hallways or the kitchen, always walk carefully. Even when it's busy, take small steps and pay attention.
 - Wear shoes with non-slip soles. They cost no more than standard shoes. Ask your manager about where to purchase them.
 - Report defective equipment or tools to a manager immediately.
 - Never operate equipment unless you have been trained how to use it properly.
 - Pay special attention when using slicers. They are very sharp and move very fast.
 - Wear nylon, no-cut gloves when cleaning slicers. If you don't have a pair, see a manager.
 - Never try to catch a falling knife. Knives are easier to replace than fingers.
 - Let people know when you're carrying anything hot or sharp. Don't be shy, yell out something like, "HOT/SHARP STUFF COMING THROUGH."
 - Don't put hot food or plates in front of small children.
 - Use proper lifting techniques. Never lift too much. If it's uncomfortable, make two trips or get some help. Remember to always bend at the knees, lift with your legs, not your back.

SANITATION

We are obsessed with sanitation and food safety! Due to the nature of the restaurant business, it is ABSOLUTELY ESSENTIAL that EVERYONE follows safe food handling procedures. This is one area of DD MAU where there is absolutely no compromise. NEVER take shortcuts on food safety and handling. Every day we are entrusted with the health and even lives of our customers. This is a huge responsibility, one that we must never take lightly.

While you will receive additional and ongoing training on food safety issues, following are some of the basic rules we ALWAYS follow and enforce:

Keep your hands washed. Always wash your hands after using the restroom, smoking, touching your hair, eating, sneezing or coughing. If you use latex gloves, change them frequently.

Sanitize everything. Besides clean hands, use sanitizing solution to constantly keep counters, cutting surfaces, and utensils sanitized. This helps to keep food handling areas and preparation tools free of bacteria.

Prevent cross-contamination. Cross-contamination occurs when raw meat comes in contact with other food that will be served without further cooking. For example, never place raw chicken on a cutting board and then cut vegetables for an uncooked product on the cutting board without first washing and sanitizing it. The same for utensils like knives and portioning tools, always wash and sanitize them after every use.

Keep food at the proper temperatures. Potentially hazardous foods like meat, poultry, dairy and fish should always be stored below 45 degrees F. Food that is cooking or in holding should always be above 140 degrees F. Bacteria count on food grows rapidly between 45 and 140 degrees F so it's imperative that our food products spend a minimum amount of time in the "temperature danger zone."

Store food correctly. Raw meat should always be stored below cooked or prepared food. Raw poultry is always placed on the bottom shelf of the walk-in. Keep chemicals and cleaning products away from food products.

DRESS CODE

To maintain our image as an exceptional, high quality restaurant we need to dress the part. Following are detailed descriptions of dress for both the counter and kitchen positions. If you have any questions regarding our dress code please ask the manager on duty.

Serving Line / Kitchen Dress Code

Shoes - shoes only with closed toe, non-slip soles that permit walking safely on wet or greasy floors. Shoes must be clean. Socks must be clean.

Pants and Belts - Clean, well-fitting pants, in good repair are required. No holes, no frayed edges, no sagging waist bands are allowed. Only dark pants are allowed. For example, dark denim jeans and pants. No sweat pants or leggings are allowed.

Shirts - DD MAU will provide you with two (2) work-approved shirts at the beginning of your employment. It is your responsibility to keep them clean and free of holes. Should you need additional shirts, speak with your supervisor. No bright shirts are allowed. Only dark blue, navy, black, grey shirts are allowed.

Appearance - Clean and well groomed hair. Hair pulled back off the shoulder. Well groomed hands, fingernails and fingernail polish. Facial hair should be neat and well trimmed.

Accessories - No excessive cologne, perfume, make-up or jewelry. No earrings longer than 1 inch for safety reasons. Only DD MAU approved hats may be worn.

ACCIDENTS AND EMERGENCY SITUATIONS

Report all accidents, no matter how minor they seem, to the manager on duty. In the event of an emergency, like an apparent injury or choking situation, notify a manager immediately. The first step is to call 911, then any person certified in CPR is expected to help the situation.

Crime and Robbery
If you are ever involved in a robbery, DO NOT RESIST. Statistics show that people who resist are three times more likely to be injured than people who do not resist. The safety of you, your fellow employees and customers are our highest priority. Don't be a hero, always cooperate fully and do not resist!

Fire Protection
All employees must know the specific location and operation of fire protection in the Restaurant. DD MAU is equipped with many fire-extinguishing systems in the ducts, hood, over the stoves and other cooking equipment that contains a dry chemical. They can be set off immediately by pulling the ring attached to each system. We also maintain hand-held CO2 systems. Be very sure before setting off a fire alarm or notifying someone to take action, these systems are expensive to clean up after and replace.

If the fire alarm sounds, assist guests to the nearest fire exit and out of the building immediately. Tell them the restaurant is under "Fire Alarm Status" and it is their responsibility to leave the restaurant through the nearest exit.

ALCOHOL SERVING POLICY

As a Restaurant that sells alcoholic beverages, we are committed to sensible, socially responsible consumption of alcohol. We help to ensure our customers' and other members of the community's safety by educating our employees on responsible service and management of alcohol. We want our customers to enjoy alcoholic beverages in moderation, but if a customer shows signs of drinking too much, a manager should be informed immediately.

Employees who serve customers must abide by the Restaurant's policies on alcoholic beverage service:
 1. We will not knowingly allow anyone on our staff that is under the legal drinking age to serve or dispense alcoholic beverages.
 2. We will not serve alcoholic beverages to an intoxicated person.
 3. We will not knowingly serve a person alcoholic beverages to a person under the legal drinking age. It is our policy to card everyone.
 4. We will offer nonalcoholic alternatives such as soft drinks, coffee, juice, etc.
 5. No person may bring their own alcohol onto the premises for any reason.

PROPRIETARY AND CONFIDENTIAL INFORMATION

It is illegal to steal, copy, communicate, or transmit a former employer's confidential or proprietary information. Proprietary information is defined as "the whole or any part of any scientific or technical information, design, process, procedure, formula, or improvement that has value and that the owner has taken measures to prevent from becoming available to persons other than those selected by the owner to have access for limited purposes." Our internal business practices, procedures and recipes are of great value to DD MAU. Employees are not to disclose any proprietary processes or recipes to any person unless directed, in writing, to do so by DD MAU management. DD MAU will institute civil action against anyone who violates this policy.

Solicitation - Employees
There should be no solicitation or distribution of literature of any kind by any employee during actual working time of the employee soliciting or the employee being solicited. Working time does not include lunch and rest breaks. Any employee who violates any part of this policy will be subject to counseling and disciplinary action up to and including dismissal.

Solicitation - Non-Employees
Non-employees are prohibited from soliciting and distributing literature at all times anywhere on Company property. Non-employees have no right of access to any area of the premises other than areas open to the public, and then only in conjunction with the area's public use.

CELLULAR PHONE USE AND MUSIC POLICY

DD MAU has adopted the following cellular phone use policy. This usage applies to any personally owned device capable of placing or receiving phone calls, messages, text or video messages, or with access to the internet or email.

Cell Phone Use For Business While Driving Is Prohibited
DD MAU is aware that some employees use their cell phones for business purposes while driving in their personal or company vehicle. It is the opinion of DD MAU that cell phone use while driving is dangerous, therefore, the company prohibits employee use of any cellular phone, either hands on or hands free, for business purposes related in any way to our company, while driving. This prohibition includes receiving or placing calls, text messaging, surfing the Internet, receiving or responding to email, checking for phone messages, or any other purpose related to your employment; the business; our customers; our vendors; volunteer activities, meetings, or civic responsibilities performed for or attended in the name of the company; or any other company related activities not named here while driving. When use of a cell phone is necessary, the employee shall park the vehicle in a manner consistent with traffic safety standards before placing or answering calls.

Cell Phones in the Restaurant - Staff
Non-management level employees are prohibited from cell phone use while at work. This prohibition includes receiving or placing calls, text messaging, listening to music, surfing the Internet, receiving or responding to email or checking for phone messages. The recognized staff level job positions for which cell phone usage is prohibited for DD MAU are as follows:
 - Kitchen workers
 - Servers
 - Bartenders
 - Bussers
 - Hosts
 - Dishwashers

Music in the Restaurant - Staff
Music can be played at a minimum before the restaurant opens. When the kitchen closes at 7:45 PM kitchen music can be played. For front of house staff, no air pods or headphones can be visible when going out to the dining room. There will be a warning and after the second warning, air pods or headphones will need to be put away. You will lose the ability to use them again.

Emergency Use of Cell Phones - Staff
DD MAU recognizes the fact many of their employees use a cell phone as a means for emergency notification by family, schools, hospitals and other persons or organizations for which emergency contact is necessary. Limited emergency use of cell phones is permitted under the following conditions:
 1. Employees must obtain permission from management prior to use.
 2. Cell phones must be in vibrate-only mode.

Violation of Policy Is Cause for Disciplinary Action
Employees who violate this policy will be subject to disciplinary action, up to and including employment termination.

HANDBOOK RECEIPT AND POLICY STATEMENT

This Employee Handbook does not constitute a contract of employment either in whole or in part. DD MAU reserves the right to add, delete, or change any portion of the Employee Handbook with or without notice.

I acknowledge receipt of, and have read, the Employee Handbook that outlines my benefits and obligations as an employee of DD MAU. I understand the Standards of Conduct and each of the rules and regulations which I am expected to follow, as well as the additional policies. I agree to abide by all of them.

All employees are expected to conform their conduct to the rules and regulations as set out in this handbook, and understand that they are at-will employees. The contents of any Employee Handbook, including this one, that may be distributed during the course of their employment shall not be construed to be a contract or in any way binding. The Company reserves the right to change, at its discretion, the contents of this handbook.

POLICY STATEMENT
This handbook is a general guide and the provisions of this handbook do not constitute an employment agreement (contract) or a guarantee of continued employment. It is simply intended to outline the benefits and work requirements for all employees. It is further understood that DD MAU reserves the right to change the provisions in this handbook at any time. It is the policy of DD MAU that employment and compensation of any employee is at will and can be terminated with or without cause, at any time, at the option of the employee or at the option of the Company.`,
        },
        es: {
            title: 'Manual del Empleado de DD Mau',
            body: `NOTA: La versión en inglés de este manual es la versión autorizada. Esta traducción al español se proporciona como cortesía. En caso de cualquier discrepancia, prevalecerá el texto en inglés.

INTRODUCCION

Lo que necesitas saber sobre DD Mau Vietnamese Eatery.

Cuando uno entra a cualquiera de los restaurantes DD Mau, es importante que se opere de la misma manera. Si un cliente visita dos restaurantes DD Mau distintos, debe esperar recibir la misma calidad de comida y servicio. Eso es lo que buscamos.

VISION DE DD MAU
Reinventar la idea de comida vietnamita fresca, saludable, vibrante y sabrosa. Buscamos la perfección y aseguramos la calidad en cada plato.

LO QUE BUSCAMOS
Lo más importante de cualquier negocio de servicio son las personas. Damos la bienvenida a los clientes cuando entran y los guiamos durante toda la experiencia. Los clientes regresan a los lugares donde se sienten bienvenidos.

DD Mau se trata de ofrecer comida vietnamita sustanciosa hecha con los ingredientes más frescos. El producto fresco y un local limpio son muy importantes para mantener una buena imagen y ganar nuevos clientes. La consistencia también juega un papel importante.

CARTA DE BIENVENIDA

Bienvenido a nuestro equipo!

Bienvenido a DD MAU. Esperamos la oportunidad de trabajar contigo y queremos que sepas que reconocemos a nuestros empleados como nuestro recurso más valioso. Nuestro éxito continuo en brindar la más alta calidad de comida, bebidas y servicio a nuestros clientes depende de tener gente de calidad como tú y tus compañeros. Queremos que disfrutes tu tiempo aquí y estamos comprometidos a ayudarte a tener éxito en tu nuevo trabajo.

Hemos preparado este manual para responder algunas de las preguntas que puedas tener sobre DD MAU y sus políticas. Este manual es solo una guía. Por favor léelo a fondo. Si tienes preguntas sobre algo, contacta a tu supervisor para que te ayude.

Esperamos que tu tiempo con nosotros sea una experiencia agradable y gratificante.

Atentamente,
Julie

ACERCA DE ESTE MANUAL

Este manual está diseñado para ayudarte a familiarizarte con DD MAU. Queremos que entiendas cómo hacemos negocios y qué tan importante eres tú y cada empleado para cuidar a nuestros invitados y hacer de este un lugar divertido y gratificante para trabajar.

Las políticas establecidas en este manual pueden cambiar de vez en cuando. Tampoco es perfecto. Hemos hecho lo mejor por incluir tanta información como sea posible de manera fácil de entender.

Este manual no es un contrato que garantice tu empleo por un tiempo específico. Tú o DD MAU pueden terminar tu empleo en cualquier momento, por cualquier razón, con o sin causa o aviso. Entiende que ningún supervisor, gerente o representante de DD MAU, excepto Julie, tiene la autoridad para entrar en cualquier acuerdo contigo para empleo por un período específico o hacer tales promesas o compromisos.

Te deseamos la mejor suerte en tu posición y esperamos que tu empleo con DD MAU sea una experiencia muy agradable y gratificante.

POLITICAS DE EMPLEO

Contratación
Es política de DD MAU contratar solo a ciudadanos estadounidenses y extranjeros autorizados para trabajar en este país. Como lo requiere la ley, los empleados deberán proveer documentos originales que establezcan esta autorización dentro de tres (3) días de su fecha de contratación. Si los documentos no son provistos dentro de este período de tres días, no tenemos opción, bajo la ley, sino terminar al empleado hasta que se provean los documentos apropiados. Empleados y empleadores deben completar el formulario provisto por el Departamento de Trabajo, formulario I-9. En la Sección 1 del formulario I-9, la información provista por el empleado debe ser válida y auténtica. Si en cualquier momento durante el empleo se descubre que algún documento usado fue inválido o no auténtico, el empleado debe, por ley, ser terminado inmediatamente.

No-Discriminación
DD MAU es un empleador de igualdad de oportunidades. No toleraremos discriminación por raza, sexo, edad, origen nacional, religión, orientación sexual, identidad de género o discapacidad. Las decisiones de empleo, como contratación, promoción, compensación, capacitación y disciplina se harán solo por razones legítimas de negocio basadas en calificaciones y otros factores no discriminatorios.

Requisitos de Edad
Todos los empleados, según la ley, deben tener al menos 18 años. Los empleados menores de 18 años deben cumplir con todas las pautas federales de salarios y horarios, sin excepciones. Los permisos de trabajo requeridos deben ser provistos cuando aplique. Ningún empleado menor de 18 años puede tomar pedidos o servir bebidas alcohólicas.

Período de Orientación
Has pasado por nuestro proceso de selección, has sido seleccionado para empleo y pareces tener el potencial para desarrollarte como un empleado exitoso. Sin embargo, queremos la oportunidad de comenzar el período de capacitación; nos gustaría conocerte para ver cómo encajas con tus compañeros y determinar si estás dispuesto y capaz de cumplir las responsabilidades del puesto para el cual fuiste contratado. También es importante que nos conozcas a nosotros y te familiarices con cómo operamos para ver si este trabajo es bueno para ti. Por lo tanto, tenemos un Período de Orientación de 2 semanas con ese propósito. Las 2 semanas permiten que tanto tú como DD MAU vean si es un buen ajuste y si no, terminar como amigos. Durante el Período de Orientación comenzarás tu capacitación y serás observado por la gerencia. También, durante este tiempo, si sientes que no entiendes lo que se espera de ti o que necesitas capacitación adicional, te animamos a preguntar y buscar ayuda adicional de nuestro personal de gerencia.

Evaluaciones
Todos los empleados serán evaluados continuamente. Cada turno es una oportunidad de aprendizaje para mejorar. Entiende que la retroalimentación se da en tiempo real y las evaluaciones escritas pueden darse periódicamente, pero no serán regulares.

El proceso de evaluación es una oportunidad para identificar logros y fortalezas, así como discutir abiertamente áreas y metas para mejorar. Dependiendo de tu posición y desempeño, puedes ser elegible para un aumento de sueldo. Los aumentos no están garantizados. Las recompensas se basan únicamente en el desempeño y resultados de la persona.

Horarios
Los horarios se preparan para satisfacer las demandas de trabajo del restaurante. A medida que las demandas cambian, la gerencia se reserva el derecho de ajustar horarios y turnos. Los horarios se publican semanalmente (11:59PM sábado). Cada empleado es responsable de trabajar sus turnos. Por favor envía tu disponibilidad y solicitudes de tiempo libre antes del miércoles para el horario del sábado.

Debes llegar a tu turno con suficiente tiempo para asegurarte de estar listo para trabajar cuando comience tu turno. Sugerimos que llegues 5 a 10 minutos antes de tu turno para tener tiempo de acomodarte y estar listo. Debes marcar entrada cuando comience tu turno y estar listo para comenzar a trabajar inmediatamente.

Los cambios de horario solo pueden permitirse si encuentras un reemplazo y obtienes aprobación del gerente. Para ser válido, el gerente debe indicar el cambio en el sistema Sling. El restaurante usualmente requiere altos niveles de personal en o alrededor de días festivos, eventos deportivos y otros eventos especiales del área. Entendemos que tienes una vida fuera del restaurante y siempre intentaremos encontrar una manera de trabajar contigo en tus solicitudes de horario. Sin embargo, te pedimos que recuerdes lo crucial que es cada puesto para el funcionamiento adecuado del restaurante. Por favor recuerda que aunque intentaremos cumplir con tus solicitudes, no hay garantía de que obtendrás el tiempo libre solicitado.

ESTANDARES DE CONDUCTA

Consistente con nuestros valores, es importante que todos los empleados estén plenamente conscientes de las reglas que gobiernan nuestra conducta y comportamiento. Para trabajar juntos como equipo y mantener un ambiente de trabajo ordenado, productivo y positivo, todos deben cumplir con los estándares de conducta razonable y las políticas del Restaurante. UN EMPLEADO INVOLUCRADO EN CUALQUIERA DE LAS SIGUIENTES CONDUCTAS PUEDE RESULTAR EN ACCIÓN DISCIPLINARIA HASTA E INCLUYENDO LA TERMINACIÓN INMEDIATA SIN AVISO ESCRITO.

 1. Autorización de Trabajo Inválida (formulario I-9).
 2. Proveer información falsa o engañosa a DD MAU, incluyendo información al momento de la solicitud de empleo, licencia o pago por enfermedad.
 3. No presentarse a un turno sin notificar al Gerente de turno. La primera instancia es causa de despido. La gerencia se reserva el derecho de tomar una determinación caso por caso (No llamar, no presentarse, no trabajo).
 4. Marcar la entrada o salida de otro empleado en el sistema de DD MAU o hacer que otro empleado te marque.
 5. Dejar tu trabajo antes del horario sin el permiso del Gerente de turno.
 6. Arresto o condena por un delito grave sin revelarlo a la gerencia por escrito.
 7. Uso de lenguaje grosero o abusivo.
 8. Conducta desordenada o indecente.
 9. Apostar en propiedad de DD MAU.
10. Robo de propiedad de clientes, empleados o DD MAU. Esto incluye cualquier artículo encontrado en las instalaciones y que se presuma perdido. El procedimiento es entregarlo a la gerencia. La gerencia retendrá la propiedad encontrada.
11. Robo, deshonestidad o manejo indebido de fondos de DD MAU. No seguir los procedimientos de procesamiento de efectivo o tarjetas.
12. Negarse a seguir instrucciones.
13. Participar en acoso de cualquier tipo hacia un cliente u otro empleado.
14. No realizar las responsabilidades del trabajo de manera satisfactoria durante el período de orientación de 30 días.
15. Uso, distribución o posesión de drogas ilegales en propiedad de DD MAU o estar bajo la influencia de estas sustancias al reportarse al trabajo o durante horas de trabajo.
16. Desperdicio o destrucción de propiedad de DD MAU.
17. Acciones o amenazas de violencia o lenguaje abusivo dirigido a un cliente u otro miembro del personal.
18. Tardanza excesiva (más de 15 minutos tarde).
19. Falla habitual al marcar entrada o salida.
20. Divulgación de información confidencial incluyendo políticas, procedimientos, recetas, manuales o cualquier información propietaria a personas fuera de DD MAU.
21. Comportamiento rudo o inapropiado con clientes incluyendo discusión de propinas.
22. Fumar o comer en áreas no aprobadas o durante descansos no autorizados.
23. No estacionarse en el área designada para empleados.
24. No cumplir con los estándares de limpieza personal y aseo de DD MAU.
25. No cumplir con los requisitos de uniforme y vestimenta de DD MAU.
26. Operación, reparación o intento de reparación no autorizado de máquinas, herramientas o equipo.
27. No reportar peligros de seguridad, defectos de equipo, accidentes o lesiones inmediatamente a la gerencia.
28. Avisos excesivos de no asistir. Falla en cumplir con tus obligaciones de turno sin importar la notificación al gerente.

POLITICA DE DROGAS Y ALCOHOL

DD MAU está comprometido a proveer un ambiente de trabajo seguro y productivo para sus empleados y clientes. El abuso de alcohol y drogas representa una amenaza para la salud y seguridad de compañeros empleados y clientes, y para la seguridad de nuestro equipo e instalaciones. Por estas razones, DD MAU está comprometido a la eliminación del uso y abuso de drogas y/o alcohol en el lugar de trabajo.

Esta política aplica a todos los empleados y aplicantes. Para efectos de esta política, "drogas" se clasifican como cualquier droga ilegal bajo ley federal, estatal o local, y/o cualquier droga ilegal bajo la Ley Federal de Sustancias Controladas.

Lugar de Trabajo Libre de Drogas y Alcohol
Los empleados deben reportarse al trabajo aptos para el deber y libres de efectos adversos de drogas ilegales o alcohol. Esta política no prohíbe el uso legal y posesión de medicamentos recetados. Sin embargo, los empleados deben consultar con sus doctores sobre el efecto del medicamento en su aptitud para el trabajo y su capacidad para trabajar con seguridad. Revela cualquier restricción de trabajo a tu supervisor con prontitud. Sin embargo, los empleados no deben revelar condiciones médicas subyacentes a los gerentes, a menos que su doctor lo indique.

Reglas de Trabajo
 - Las drogas ilegales se definen en esta política para incluir: cocaína, éxtasis, alucinógenos, anfetaminas, esteroides, heroína, PCP, marihuana y otras sustancias ilegales en Missouri.
 - El uso de marihuana por razones médicas o recreativas, la marihuana en el lugar de trabajo no está permitida. Un empleado no puede estar bajo la influencia de marihuana mientras trabaja.
 - Mientras los empleados estén trabajando, operando un vehículo de la empresa, presentes en las instalaciones de la empresa o conduciendo trabajo relacionado fuera del sitio, tienen prohibido usar, poseer, comprar, vender, manufacturar o dispensar una droga ilegal (incluyendo posesión de parafernalia); o estar bajo la influencia de alcohol o una droga ilegal según se define en esta política.
 - La presencia de cualquier cantidad detectable de cualquier droga ilegal o sustancia controlada ilegal en el cuerpo de un empleado mientras realiza negocios de la empresa o mientras está en una instalación de la empresa está prohibido.
 - DD MAU no permitirá que ningún empleado realice sus deberes mientras toma medicamentos recetados que afectan adversamente la capacidad del empleado para realizar sus deberes de manera segura y efectiva. Los empleados que tomen un medicamento recetado deben llevarlo en el envase etiquetado por un farmacéutico autorizado o estar preparados para producirlo si se les solicita antes de su siguiente turno programado.
 - Cualquier droga ilegal o parafernalia será entregada a la agencia de aplicación de la ley apropiada y puede resultar en procesamiento criminal.

Pruebas Requeridas
La empresa retiene el derecho de requerir las siguientes pruebas:
 - Sospecha razonable: Los empleados pueden ser sujetos a pruebas basadas en observaciones de un supervisor de aparente uso, posesión o impedimento en el lugar de trabajo.
 - Post-accidente: Los empleados pueden ser sujetos a pruebas cuando causen o contribuyan a accidentes que dañen seriamente un vehículo de la empresa, maquinaria, equipo o propiedad y/o resulten en una lesión a sí mismos u otro empleado que requiera atención médica fuera del sitio. En cualquiera de estas instancias, la investigación y prueba subsecuente puede programarse dentro de dos (2) horas después del accidente, si no antes.

Inspecciones
DD MAU se reserva el derecho de inspeccionar todas las porciones de sus instalaciones por drogas, alcohol u otro contrabando. Todos los empleados y visitantes pueden ser pedidos a cooperar en inspecciones de sus personas, áreas de trabajo y propiedad que pudieran ocultar drogas, alcohol u otro contrabando. Los empleados que posean tal contrabando o se nieguen a cooperar en tales inspecciones están sujetos a disciplina apropiada hasta e incluyendo el despido.

Crímenes Que Involucran Drogas
DD MAU prohíbe a todos los empleados manufacturar, distribuir, dispensar, poseer o usar una droga ilegal en o dentro de las instalaciones de la empresa o mientras realizan negocios de la empresa. Los empleados también tienen prohibido el mal uso de medicamentos recetados legalmente o de venta libre. El personal de la policía será notificado, según corresponda, cuando se sospeche actividad criminal.

Uso de Marihuana
DD MAU está comprometido a asegurar un ambiente de trabajo seguro, saludable y productivo para todos los empleados. Usar marihuana en el lugar de trabajo daña la productividad y representa un peligro para todos. Por estas razones, DD MAU prohíbe el uso de marihuana en el lugar de trabajo. El cumplimiento con esta política es una condición de empleo continuo para todos los empleados. DD MAU cumple con todas las leyes y regulaciones estatales y federales sobre uso de marihuana. Esta política aborda la prohibición contra el uso de marihuana en el lugar de trabajo.

Conducta Prohibida
Los empleados tienen prohibido reportarse al trabajo o trabajar bajo la influencia de marihuana, lo cual puede afectar adversamente su capacidad para realizar sus deberes de manera segura y efectiva. Los empleados también tienen prohibido consumir, fumar o ingerir marihuana antes del horario de trabajo, durante horario de trabajo, incluyendo durante comidas y descansos. DD MAU no acomoda el uso médico de marihuana en el lugar de trabajo. Los empleados, incluyendo usuarios de marihuana medicinal autorizada por el estado, tienen prohibido usar marihuana mientras están en el trabajo.

Violaciones de la Política de Uso de Marihuana del Empleador
Los empleados que no cumplan con la política de uso de marihuana de DD MAU están sujetos a disciplina, pruebas requeridas, también hasta e incluyendo el despido.

ACOSO

Es política de DD MAU tratar a todo el personal con dignidad y respeto y tomar decisiones de personal sin tener en cuenta raza, sexo, edad, color, origen nacional, religión, orientación sexual, identidad de género o discapacidad. Nos esforzamos por proveer a todos un lugar de trabajo libre de acoso de cualquier tipo. Se anima a los empleados a reportar incidencias de acoso prontamente.

Acoso Sexual
DD MAU está comprometido a proveer un ambiente de trabajo libre de todas formas de discriminación y conducta que pueda considerarse acosadora, abusiva, coercitiva o disruptiva, incluyendo acoso sexual y otros tipos. Acciones, palabras, bromas o comentarios basados en el sexo, raza, color, origen nacional, edad, religión, discapacidad, embarazo, orientación sexual, identidad de género, expresión de género, estado de veterano, deber militar, información genética o cualquier otra característica legalmente protegida no serán toleradas.

Todos los empleados, incluyendo empleados por hora, miembros de la gerencia y ejecutivos, tienen prohibido participar en acoso de cualquier tipo. DD MAU también tomará pasos apropiados para asegurar que sus empleados no estén sujetos a acoso por invitados, vendedores o miembros del público. El acoso no será tolerado y resultará en acción disciplinaria, hasta e incluyendo la terminación inmediata. Los violadores no empleados de esta política están sujetos a expulsión de las instalaciones de DD MAU.

Definición de Acoso Sexual
El acoso basado en una característica legalmente protegida es discriminación ilegal e ilegal bajo ley federal y muchas leyes estatales y locales. El acoso es un patrón de conducta física y/o verbal que un empleado razonable encontraría intimidante, indeseable u ofensivo y tiene el propósito o efecto de interferir con el desempeño laboral o crear un ambiente de trabajo intimidante, hostil u ofensivo.

Los tipos de conducta prohibidos incluyen pero no se limitan a:
 - Conducta verbal como epítetos, comentarios despectivos, lenguaje grosero u obsceno, bromas, apodos, insultos, burlas, amenazas.
 - Conducta visual como carteles ofensivos, tarjetas, calendarios, fotografías, caricaturas, grafiti, dibujos o gestos.
 - Conducta física como asalto, contacto no deseado, bloquear el movimiento normal o interferir con el trabajo.

El acoso sexual incluye avances sexuales no deseados, solicitudes de favores sexuales y otra conducta verbal o física de naturaleza sexual, cuando:
 - La sumisión a tal conducta se hace explícita o implícitamente un término o condición del empleo; o
 - La sumisión o rechazo de tal conducta se usa como base para decisiones de empleo; o
 - Tal conducta tiene el propósito o efecto de interferir irrazonablemente con el desempeño laboral o crear un ambiente intimidante, hostil u ofensivo.

Ejemplos específicos de Acoso Sexual incluyen:
 - Avances o proposiciones sexuales no deseados, solicitudes de favores sexuales, coqueteo, gestos sugestivos, silbar o mirar lujuriosamente.
 - Contacto físico no deseado, incluyendo palmadas, pellizcos, besos, agarrar, abrazar, rozar contra otra persona o tocar inapropiadamente.
 - Violencia física, incluyendo asalto sexual.
 - Bromas sexuales, burlas, ruidos sugestivos, comentarios sobre apariencia o vida personal, o historias sexuales.
 - Exhibición de materiales sexualmente explícitos u ofensivos en el lugar de trabajo, incluyendo en computadora, smartphone, por correo o mensaje de texto.

Reportar el Acoso Es Responsabilidad de Todos
DD MAU solo puede remediar el acoso que tú llevas a nuestra atención. Para dar a la Compañía la oportunidad de abordar y prevenir futuras ocurrencias de acoso, es responsabilidad de todos reportar inmediatamente cualquier conducta que crean que pueda violar esta política, ya sean víctimas o testigos. Sin importar si estás seguro de que el comportamiento de otra persona realmente constituye "acoso", es tu responsabilidad reportar el comportamiento lo antes posible. Rara vez, si acaso, debes esperar más del siguiente día hábil antes de reportar conducta que viole esta política.

Procedimientos para Reportar Reclamos de Acoso
Los empleados deben reportar la conducta inmediatamente al gerente de turno del restaurante. Si el gerente de turno no responde a tiempo, o si el empleado cree que sería inapropiado reportar la conducta a esa persona, el empleado debe contactar inmediatamente al Gerente General. Si el Gerente General no responde a tiempo o sería inapropiado reportar al Gerente General, el empleado debe contactar inmediatamente al supervisor del Gerente General, Julie.

La disponibilidad de estos procedimientos de queja no excluye que las personas que crean estar sujetas a conducta acosadora también puedan advertir al ofensor prontamente que su comportamiento es no bienvenido y solicitar que sea descontinuado. Cualquier empleado puede expresar preocupaciones y hacer reportes sin temor a represalias.

Investigación de Reclamos
Tus preocupaciones serán investigadas prontamente y se tomará la acción remedial apropiada en caso que se determine que ocurrieron violaciones de la política. Todos los reclamos se mantendrán con la mayor confidencialidad posible, excepto lo necesario para completar una investigación.

Dependiendo de la naturaleza y circunstancia del acoso, la disciplina puede incluir, pero no se limita a, consejería, suspensión sin pago y/o terminación. La acción disciplinaria también puede tomarse contra miembros de la gerencia que sepan del comportamiento o de una queja y fallen en tomar acción inmediata y apropiada.

Las acusaciones falsas de acoso pueden tener efectos serios en otros empleados y la cultura de la Compañía. Si, después de la investigación, queda claro que un empleado denunciante o testigo ha hecho maliciosa o imprudentemente una acusación falsa, estará sujeto a disciplina, hasta e incluyendo la terminación.

Represalias Prohibidas
Cualquier empleado que, de buena fe, traiga un reclamo de acoso, aparezca como testigo o asista en una investigación de tal reclamo, sirva como investigador del reclamo, esté asociado con otro empleado que hizo un reclamo o haya participado en la investigación no será afectado adversamente en términos de empleo o sujeto a represalias o despido por el reclamo. Los reclamos de represalias deben reportarse inmediatamente usando el mismo procedimiento de queja arriba indicado y serán investigados prontamente. Las represalias o amenazas de represalias serán motivo de acción disciplinaria, hasta e incluyendo la terminación.

AUSENCIAS

Se espera que todos los empleados trabajen de manera regular y consistente y completen sus horas regularmente programadas por semana. El ausentismo excesivo puede resultar en acción disciplinaria, hasta e incluyendo la terminación. La acción disciplinaria tomada por ausentismo se considerará caso por caso, después de una revisión del registro de asistencia y trabajo general del empleado.

 - Si vas a faltar al trabajo, se espera que los empleados llamen y hablen con un supervisor al menos 2 horas antes de su turno programado. Si vas al hospital, necesitas proveer una nota del doctor. El gerente determinará si la ausencia es justificada o no.
 - Cualquier empleado que no llame ni se reporte para un turno (sin llamar, sin presentarse) se considerará que ha renunciado voluntariamente al empleo de DD MAU.
 - Antes de tomar una licencia para vacaciones, asuntos personales, militar o jurado, u otra ausencia planeada, se debe enviar una Solicitud de Tiempo Libre a través de la app Sling lo antes posible y ser aprobada por un supervisor.
 - Las Solicitudes de Tiempo Libre deben enviarse a más tardar el jueves antes de la publicación del horario de trabajo para las fechas de licencia programadas, a menos que la solicitud sea debido a una emergencia inesperada. Entonces la naturaleza de la emergencia debe compartirse con tu supervisor para que se pueda hacer una determinación.
 - Para regresar al trabajo de un accidente o licencia médica, todos los empleados deben presentar una autorización del doctor.
 - Cualquier empleado que falle en regresar al trabajo al expirar una licencia personal se considerará que ha abandonado su trabajo, a menos que DD MAU sea notificado de una razón satisfactoria para no regresar al final de la licencia.

Tardanza
Los empleados deben estar preparados para comenzar a trabajar puntualmente al inicio del turno. Siempre llega al Restaurante 5 a 10 minutos antes de tu turno. Tu hora programada es la hora en que se espera que estés en tu trabajo, no llegando al Restaurante. La tardanza repetida es motivo de terminación. Si no es posible que comiences a trabajar a tu hora programada, debes llamar al Restaurante y hablar con el Gerente de turno.

Renuncias
Se solicita que des un aviso de dos semanas de tus planes de dejar el restaurante. Un aviso es importante para que tengamos tiempo de contratar a alguien que tome tu lugar. Dar un aviso de dos semanas es una cortesía profesional y asegura que seas elegible para re-contratación y no tengas un "dejó sin aviso de renuncia" en tu registro de empleo.

PROCEDIMIENTOS DE PAGO

Procedimientos del Reloj de Tiempo
Debes llegar al restaurante 5 a 10 minutos antes de tu hora programada de comenzar a trabajar. Notifica al Gerente de turno que has llegado a tu turno. Puedes marcar entrada dentro de los 15 minutos del inicio de tu turno. Todos los empleados por hora reciben un número de identificación para marcar entrada y salida en el sistema del Restaurante.

Manipular, alterar o falsificar registros de tiempo o registrar tiempo con el ID de otro empleado no está permitido y puede resultar en acción disciplinaria, hasta e incluyendo la terminación.

Propinas
DD Mau paga a cada empleado al menos el salario mínimo de Missouri; NO tomamos un crédito por propinas. Como pagamos el salario mínimo completo, la ley federal nos permite operar un fondo común de propinas obligatorio que incluye tanto al personal del frente de la casa (FOH) como al de la cocina (BOH). Los dueños, gerentes y supervisores están excluidos del fondo, como lo requiere la ley.

Cómo funciona el fondo común:
 - Todas las propinas recibidas durante el período de pago (efectivo + tarjeta) se juntan.
 - 50% del fondo se asigna a la porción FOH, 50% se asigna a la porción BOH.
 - La porción FOH se divide entre el total de horas FOH trabajadas durante el período de pago para producir una tasa FOH de dólares por hora.
 - La porción BOH se divide entre el total de horas BOH trabajadas durante el período de pago para producir una tasa BOH de dólares por hora.
 - Tu porción del fondo = tus horas trabajadas en tu lado x la tasa de dólares por hora de ese lado.

Las propinas del fondo se agregan a tu cheque al final de cada período de pago. Las propinas de tarjeta de crédito pueden reducirse por la tarifa de procesamiento proporcional de esa transacción, según lo permite la ley.

Eres responsable de reportar con exactitud el ingreso por propinas a DD Mau y al IRS. Retendremos los impuestos aplicables sobre las propinas reportadas.

Cheques de Pago
Los cheques están disponibles en el Restaurante el viernes de la semana de pago de cada mes durante horario de negocio. Después del día de pago, puedes recoger tu cheque durante las mismas horas. Por favor entiende que puede ser difícil que alguien esté disponible para entregar tu cheque durante horas pico de negocio, así que planea acordemente.

Deducciones de Nómina
Tu cheque indicará tus ganancias brutas así como deducciones por retenciones de impuestos federales y estatales y de seguro social y Medicare. Las retenciones federales y estatales son autorizadas por ti basadas en la información que nos proveíste en el formulario W-4. Si quieres una explicación de tus deducciones o si deseas cambiarlas, por favor habla con tu supervisor.

Según ley estatal, DD MAU cumple con órdenes judiciales en relación con embargos de cheques de empleados según indiquen las autoridades. Serás notificado de cualquier deducción de nómina ordenada por la corte.

Cambio de Dirección
Te pedimos que reportes cualquier cambio de dirección a tu supervisor lo antes posible para que tu estado de cuenta de ingresos y deducciones de fin de año, formulario W-2, sea enviado por correo a la dirección correcta.

Cheques Perdidos
Reporta cheques perdidos al gerente. Pararemos el pago del cheque perdido y emitiremos otro cheque en el siguiente ciclo de nómina. El cheque reemitido incurrirá en una deducción igual al cargo de parar pago del banco.

BENEFICIOS

Días Festivos
Debido a la naturaleza del negocio de restaurantes, puedes ser requerido a trabajar días festivos. Actualmente nuestra política es cerrar el Restaurante para negocio en los siguientes días festivos: Día de Acción de Gracias, Día de Navidad y Día de Pascua.

Vacaciones
Las vacaciones son provistas por el Restaurante para permitir a los empleados dejar su ambiente de trabajo por un período y deben tomarse dentro del año en que se ganaron.

Todos los empleados de tiempo completo que hayan estado con el Restaurante por un período consecutivo de 12 meses son elegibles para una semana de vacaciones pagadas. Los empleados se consideran de tiempo completo si promediaron más de 40 horas de trabajo por semana el año anterior.

Los formularios de Solicitud de Licencia de Empleado para vacaciones están disponibles con los supervisores y deben enviarse al supervisor inmediato del empleado y ser aprobados antes de conceder la licencia. Se pide a los empleados enviar solicitudes de vacaciones al menos un mes antes de la fecha programada, a menos que la solicitud sea debido a una situación inesperada. Se harán esfuerzos para conceder el tiempo de vacaciones como se solicite, pero las necesidades de negocio pueden requerir que un empleado ajuste su tiempo de vacaciones.

Compensación al Trabajador
La compensación al trabajador provee beneficios para empleados que sufren lesión personal por accidentes o enfermedades que surjan en el curso de su empleo con el Restaurante. Un empleado lesionado en el trabajo, sin importar la severidad, debe:
 - Reportar la ocurrencia al gerente de turno.
 - El gerente de turno necesitará obtener información sobre exactamente lo que sucedió, cómo ocurrió la lesión o enfermedad, la hora y ubicación exacta, así como cualquier testigo.

Si un empleado experimenta una lesión laboral incapacitante, cuya naturaleza necesite ausencia del trabajo, los supervisores proveerán al empleado información sobre sus beneficios legales.

Comidas del Empleado
Los empleados reciben una comida durante cada turno. Si te gustaría comprar comida durante tu turno, cada empleado recibe un descuento del 15%. Por favor limita tu compra a comida solo para ti.

USO DE REDES SOCIALES POR EL EMPLEADO

Mientras DD MAU anima a sus empleados a disfrutar y hacer buen uso de su tiempo fuera del trabajo, ciertas actividades pueden volverse un problema si tienen el efecto de perjudicar el trabajo de cualquier empleado; acosar, denigrar o crear un ambiente hostil para cualquier empleado; perturbar el flujo de trabajo dentro de la compañía; directa o indirectamente divulgar información confidencial o propietaria; o dañar la buena voluntad y reputación de DD MAU entre sus clientes o en la comunidad. En el área de redes sociales (impreso, transmisión, digital y en línea), los empleados pueden usar tales medios de la manera que elijan siempre que dicho uso no produzca las consecuencias adversas mencionadas.

Por esta razón, DD MAU recuerda a sus empleados que las siguientes pautas aplican en su uso de redes sociales, dentro y fuera de su horario laboral:

 1. Si un empleado publica cualquier información personal sobre sí mismo, otro empleado de DD MAU, un cliente o un cliente en cualquier medio público (impreso, transmisión, digital o en línea) que:
    a. tenga el potencial o efecto de involucrar al empleado, sus compañeros o DD MAU en cualquier tipo de disputa o conflicto;
    b. interfiera con el trabajo de cualquier empleado;
    c. cree un ambiente de trabajo acosador, denigrante u hostil;
    d. perturbe el flujo de trabajo en la oficina o el servicio a los clientes;
    e. dañe la buena voluntad y reputación de DD MAU;
    f. tienda a poner en duda la confiabilidad o buen juicio de la persona sujeto de la información; o
    g. revele información propietaria o secretos comerciales de DD MAU;
    entonces los empleados responsables pueden estar sujetos a consejería y/o acción disciplinaria, hasta e incluyendo la terminación.

 2. Ningún empleado de DD MAU puede usar equipo o instalaciones de la compañía para promover actividades o relaciones no relacionadas con el trabajo sin el permiso expreso y escrito de Julie Truong.

 3. Los empleados que se conduzcan de manera que sus acciones y relaciones puedan convertirse en objeto de chisme en el lugar de trabajo, o causar publicidad desfavorable para DD MAU, deben preocuparse de que su conducta pueda ser inconsistente con una o más de las pautas anteriores. En tal situación, los empleados involucrados deben pedir orientación a Julie para discutir la posibilidad de una resolución. Dependiendo de las circunstancias, no buscar tal orientación puede considerarse evidencia de intento de ocultar una violación.

 4. Si decides crear un blog personal, asegúrate de proveer un descargo claro de que las opiniones expresadas en dicho blog son solo del autor y no representan las opiniones de DD MAU.

 5. Toda información publicada en cualquier blog del empleado debe cumplir con las políticas de confidencialidad y divulgación de DD MAU. Esto también aplica a comentarios publicados en otros sitios de redes sociales, blogs y foros.

 6. Sé respetuoso con DD MAU, compañeros, clientes, socios y competidores, y sé consciente de tu seguridad física al publicar información sobre ti u otros en cualquier foro. Describir detalles íntimos de tu vida personal y social, o proveer información sobre tus movimientos detallados puede interpretarse como invitación para más comunicación, o incluso acoso que podría ser peligroso para tu seguridad física.

 7. Las actividades de redes sociales nunca deben interferir con los compromisos laborales.

 8. Tu presencia en línea puede reflejarse en DD MAU. Sé consciente de que tus comentarios, publicaciones o acciones capturadas en imágenes digitales o de película pueden afectar la imagen de DD MAU.

 9. No discutas clientes, clientes o socios de la compañía sin su consentimiento expreso.

10. No ignores las leyes de derechos de autor; cita o referencia fuentes con precisión. Recuerda que la prohibición contra el plagio aplica en línea.

11. No uses logos o marcas de DD MAU sin consentimiento escrito. La ausencia de referencia explícita a un sitio en particular no limita la extensión de la aplicación de esta política. Si no existe política o pauta, los empleados de DD MAU deben usar su juicio profesional. Si tienes dudas, consulta a tu supervisor o gerente antes de proceder.

POLITICAS Y PRACTICAS DEL RESTAURANTE

Servicio al Cliente
Nuestro restaurante existe solo gracias a los clientes. En particular, los clientes que regresan voluntariamente y eligen gastar su dinero en nuestra comida y bebidas. Sin nuestros clientes no tenemos restaurante, son la única razón por la que estamos aquí. Como resultado, cuidar a nuestros clientes es nuestra mayor prioridad, de hecho un privilegio, nunca una interrupción. En DD MAU el cliente siempre va primero!

Quejas de Clientes
A nadie le gusta recibir quejas de clientes, pero las quejas son de esperarse como parte de estar en el negocio de hospitalidad. Las quejas pueden incluso verse de manera positiva si se manejan apropiadamente. Pueden darnos perspectiva sobre cómo mejorar nuestro Restaurante, los clientes exigentes nos obligan a ser nuestro mejor y resolver quejas satisfactoriamente puede incluso aumentar la lealtad del cliente.

Cuando enfrentes una queja de cliente:
 - No te pongas a la defensiva.
 - No intentes explicar la situación.
 - Retira el artículo ofensivo inmediatamente.
 - Discúlpate por el problema y dile al cliente que te encargarás del problema.
 - Si necesitas la ayuda de un gerente, no dudes en pedirla.

Haz todo lo posible para que el cliente sepa que te importa y que esta no es la clase de experiencia que quieres que tengan en nuestro restaurante.

Cortesía Telefónica
TODAS LAS LLAMADAS EN NUESTROS TELÉFONOS DE EMPRESA SON GRABADAS.

Es responsabilidad de todos contestar el teléfono. Siempre contesta puntualmente, dentro de dos tonos. Siempre contesta de manera amable: "Buenos días/tardes/noches, DD MAU, en qué le puedo ayudar?"

Responde a cualquier pregunta de la que estés absolutamente seguro de la respuesta. Si tienes dudas, pídele a la persona que la pongas en espera un momento y refiere rápidamente la llamada a un gerente. Siempre agradece a la persona por llamar. Siempre pide el nombre del que llama cuando pidan hablar con un gerente.

Relaciones Gerencia / Empleado
Nuestros gerentes están comprometidos y entrenados para proveerte con las herramientas y un ambiente de trabajo positivo para que hagas tu trabajo lo mejor posible con mínimas distracciones. Serás tratado con respeto y dignidad por todo nuestro personal de gerencia e intentaremos lo mejor por reconocer y recompensar tu trabajo duro y logros.

Reconocemos que puede haber ocasiones para malentendidos y problemas. Queremos aclarar estas situaciones de manera justa y oportuna, y para hacerlo necesitamos tu ayuda en traerlas a nuestra atención. Queremos que sepas que la gerencia nunca está demasiado ocupada para ser informada de problemas, quejas o disputas relacionadas al trabajo.

Si tienes tal problema, debes hablar prontamente con Julie. Escucharán de manera abierta, objetiva y cortés. Queremos entender y resolver el problema.

Cada acción necesaria será tomada para resolver un problema o una disputa de manera justa y equitativa. Como dijimos en la "Carta de Bienvenida", reconocemos a nuestros empleados como nuestro recurso más valioso y tomamos todos los problemas y quejas de empleados muy en serio. Ningún problema es demasiado pequeño o insignificante y cada asunto recibirá la máxima atención y consideración.

Reuniones
Las reuniones de personal se hacen para tu beneficio así como para el del Restaurante. Las reuniones se hacen por varias razones y pueden incluir nuevas ofertas de menú, promociones próximas, eventos, capacitación, políticas, etc. Tales reuniones se tratan como un turno, la asistencia es obligatoria y serás pagado acordemente. Solo se aceptarán ausencias aprobadas por la gerencia. La mayoría de reuniones ofrecen a los empleados la oportunidad de proveer aportes valiosos y sugerencias para mejorar nuestro ambiente de trabajo y la operación del Restaurante.

Trabajo en Equipo
No podemos lograr nuestras metas y proveer los más altos niveles de servicio sin trabajar juntos como equipo. El trabajo en equipo básicamente se reduce a cortesía común y sentido común. Si un compañero está sobrecargado y tú no, ayúdalo de cualquier manera que puedas. Solo es cuestión de tiempo antes que ellos devuelvan el favor. Ayuda a un cliente sea técnicamente tuyo o no. Si otro empleado no ha entendido algo y tú sí, pregúntale si puedes sugerir otra manera de hacerlo. El trabajo en equipo genuino hace una experiencia laboral mucho más agradable y satisfactoria y resulta en clientes más felices (y más generosos).

Comunicación
Es importante que cada empleado tenga un buen sentido de "lo que está pasando" en el Restaurante. Es responsabilidad de la gerencia mantener a todos informados de cambios y noticias que afecten al Restaurante y nuestra gente. Tal comunicación se da principalmente en reuniones pre-turno, reuniones generales y publicando avisos e información en la pizarra junto a la oficina del gerente.

SEGURIDAD

DD MAU está comprometido a mantener un lugar de trabajo seguro para todos nuestros empleados. El momento de estar consciente de la seguridad es antes de que ocurra un accidente. La seguridad es responsabilidad de todos y es una parte regular y continua del trabajo de todos.

Recibirás más información detallada y capacitación sobre temas de seguridad como parte continua de tu empleo. Sin embargo, aquí hay algunas pautas básicas y reglas de seguridad a siempre tener en mente:
 - Limpia los derrames inmediatamente.
 - Nunca corras en pasillos o la cocina, siempre camina con cuidado. Incluso cuando esté ocupado, da pasos pequeños y presta atención.
 - Usa zapatos con suelas antideslizantes. No cuestan más que zapatos estándar. Pregúntale a tu gerente dónde comprarlos.
 - Reporta equipo o herramientas defectuosas a un gerente inmediatamente.
 - Nunca operes equipo a menos que hayas sido entrenado en cómo usarlo apropiadamente.
 - Presta atención especial al usar rebanadoras. Son muy filosas y se mueven muy rápido.
 - Usa guantes de nylon anti-corte al limpiar rebanadoras. Si no tienes un par, ve a un gerente.
 - Nunca trates de atrapar un cuchillo cayendo. Los cuchillos son más fáciles de reemplazar que los dedos.
 - Avisa a la gente cuando lleves algo caliente o filoso. No seas tímido, grita algo como "CALIENTE/FILOSO PASANDO."
 - No pongas comida caliente o platos frente a niños pequeños.
 - Usa técnicas apropiadas de levantamiento. Nunca levantes demasiado. Si es incómodo, haz dos viajes o consigue ayuda. Recuerda siempre doblar las rodillas, levantar con tus piernas, no con tu espalda.

SANEAMIENTO

Estamos obsesionados con el saneamiento y la seguridad alimentaria! Debido a la naturaleza del negocio de restaurantes, es ABSOLUTAMENTE ESENCIAL que TODOS sigan procedimientos seguros de manejo de alimentos. Esta es un área de DD MAU donde absolutamente no hay compromiso. NUNCA tomes atajos en seguridad y manejo de alimentos. Cada día se nos confía la salud e incluso la vida de nuestros clientes. Esta es una gran responsabilidad, una que nunca debemos tomar a la ligera.

Mientras recibirás capacitación adicional y continua sobre seguridad alimentaria, las siguientes son algunas de las reglas básicas que SIEMPRE seguimos y hacemos cumplir:

Mantén tus manos lavadas. Siempre lava tus manos después de usar el baño, fumar, tocar tu cabello, comer, estornudar o toser. Si usas guantes de látex, cámbialos frecuentemente.

Desinfecta todo. Además de manos limpias, usa solución desinfectante constantemente en mostradores, superficies de corte y utensilios. Esto ayuda a mantener áreas de manejo de comida y herramientas de preparación libres de bacterias.

Previene la contaminación cruzada. La contaminación cruzada ocurre cuando carne cruda entra en contacto con otra comida que se servirá sin más cocción. Por ejemplo, nunca pongas pollo crudo en una tabla y luego cortes vegetales para un producto no cocido en la tabla sin primero lavarla y desinfectarla. Lo mismo con utensilios como cuchillos y herramientas de porción, siempre lava y desinfecta después de cada uso.

Mantén la comida a temperaturas apropiadas. Comidas potencialmente peligrosas como carne, aves, lácteos y pescado deben siempre almacenarse abajo de 45 grados F. La comida que se está cocinando o en espera debe siempre estar arriba de 140 grados F. La cuenta bacteriana crece rápidamente entre 45 y 140 grados F así que es imperativo que nuestros productos pasen un tiempo mínimo en la "zona de peligro de temperatura".

Almacena la comida correctamente. La carne cruda debe siempre almacenarse abajo de comida cocida o preparada. Las aves crudas siempre se colocan en el estante de abajo del refrigerador. Mantén químicos y productos de limpieza lejos de los productos de comida.

CODIGO DE VESTIMENTA

Para mantener nuestra imagen como un restaurante excepcional y de alta calidad necesitamos vestirnos para el papel. Las siguientes son descripciones detalladas de vestimenta para las posiciones de mostrador y cocina. Si tienes preguntas sobre nuestro código de vestimenta por favor pregúntale al gerente de turno.

Código de Vestimenta de Línea de Servicio / Cocina

Zapatos - solo zapatos con punta cerrada, suelas antideslizantes que permitan caminar con seguridad en pisos mojados o grasosos. Los zapatos deben estar limpios. Los calcetines deben estar limpios.

Pantalones y Cinturones - Se requieren pantalones limpios, bien ajustados y en buenas condiciones. No se permiten hoyos, bordes deshilachados o pretinas caídas. Solo se permiten pantalones oscuros. Por ejemplo, jeans y pantalones de mezclilla oscura. No se permiten pantalones deportivos o leggings.

Camisas - DD MAU te proveerá con dos (2) camisas aprobadas para trabajo al inicio de tu empleo. Es tu responsabilidad mantenerlas limpias y libres de hoyos. Si necesitas camisas adicionales, habla con tu supervisor. No se permiten camisas brillantes. Solo se permiten camisas azul oscuro, marino, negro, gris.

Apariencia - Cabello limpio y bien arreglado. Cabello recogido fuera del hombro. Manos, uñas y esmalte bien arreglados. El vello facial debe ser pulcro y bien recortado.

Accesorios - Sin colonia, perfume, maquillaje o joyería excesivos. Sin aretes de más de 1 pulgada por razones de seguridad. Solo pueden usarse sombreros aprobados por DD MAU.

ACCIDENTES Y SITUACIONES DE EMERGENCIA

Reporta todos los accidentes, no importa qué tan menores parezcan, al gerente de turno. En caso de emergencia, como una lesión aparente o situación de asfixia, notifica a un gerente inmediatamente. El primer paso es llamar al 911, luego cualquier persona certificada en RCP debe ayudar.

Crimen y Robo
Si alguna vez estás involucrado en un robo, NO RESISTAS. Las estadísticas muestran que las personas que resisten son tres veces más propensas a lesionarse. La seguridad tuya, de tus compañeros y clientes es nuestra mayor prioridad. No seas un héroe, siempre coopera completamente y no resistas!

Protección Contra Incendios
Todos los empleados deben conocer la ubicación específica y operación de la protección contra incendios en el Restaurante. DD MAU está equipado con muchos sistemas de extinción de incendios en los ductos, campana, sobre las estufas y otro equipo de cocina que contienen un químico seco. Pueden activarse inmediatamente jalando el anillo conectado a cada sistema. También mantenemos sistemas portátiles de CO2. Asegúrate antes de activar una alarma o notificar a alguien para tomar acción, estos sistemas son caros de limpiar y reemplazar.

Si suena la alarma de incendio, asiste a los invitados a la salida de incendio más cercana y fuera del edificio inmediatamente. Diles que el restaurante está en "Estado de Alarma de Incendio" y es su responsabilidad dejar el restaurante por la salida más cercana.

POLITICA DE SERVICIO DE ALCOHOL

Como Restaurante que vende bebidas alcohólicas, estamos comprometidos al consumo sensato y socialmente responsable de alcohol. Ayudamos a asegurar la seguridad de nuestros clientes y otros miembros de la comunidad educando a nuestros empleados sobre el servicio y manejo responsable de alcohol. Queremos que nuestros clientes disfruten bebidas alcohólicas con moderación, pero si un cliente muestra señales de beber demasiado, un gerente debe ser informado inmediatamente.

Los empleados que sirven a clientes deben cumplir con las políticas del Restaurante sobre servicio de bebidas alcohólicas:
 1. No permitiremos conscientemente que nadie en nuestro personal que sea menor de edad legal para beber sirva o dispense bebidas alcohólicas.
 2. No serviremos bebidas alcohólicas a una persona intoxicada.
 3. No serviremos conscientemente bebidas alcohólicas a una persona menor de edad legal para beber. Es nuestra política pedir identificación a todos.
 4. Ofreceremos alternativas no alcohólicas como refrescos, café, jugo, etc.
 5. Ninguna persona puede traer su propio alcohol a las instalaciones por ninguna razón.

INFORMACION PROPIETARIA Y CONFIDENCIAL

Es ilegal robar, copiar, comunicar o transmitir la información confidencial o propietaria de un empleador anterior. La información propietaria se define como "el todo o cualquier parte de cualquier información científica o técnica, diseño, proceso, procedimiento, fórmula o mejora que tiene valor y que el dueño ha tomado medidas para prevenir que esté disponible a personas distintas a las seleccionadas por el dueño." Nuestras prácticas de negocio internas, procedimientos y recetas son de gran valor para DD MAU. Los empleados no deben divulgar ningún proceso o receta propietaria a ninguna persona a menos que sea dirigido, por escrito, por la gerencia de DD MAU. DD MAU instituirá acción civil contra cualquiera que viole esta política.

Solicitación - Empleados
No debe haber solicitación o distribución de literatura de ningún tipo por ningún empleado durante tiempo real de trabajo del empleado solicitando o del empleado siendo solicitado. El tiempo de trabajo no incluye almuerzo y descansos. Cualquier empleado que viole esta política estará sujeto a consejería y acción disciplinaria hasta e incluyendo el despido.

Solicitación - No-Empleados
A los no empleados se les prohíbe solicitar y distribuir literatura en todo momento en cualquier parte de la propiedad de la Compañía. Los no empleados no tienen derecho de acceso a ningún área de las instalaciones excepto las áreas abiertas al público, y solo en conjunto con el uso público del área.

POLITICA DE USO DE CELULAR Y MUSICA

DD MAU ha adoptado la siguiente política de uso de celular. Este uso aplica a cualquier dispositivo personal capaz de hacer o recibir llamadas, mensajes, mensajes de texto o video, o con acceso a internet o correo.

Uso de Celular Para Negocio Mientras se Conduce Está Prohibido
DD MAU es consciente de que algunos empleados usan sus celulares para propósitos de negocio mientras conducen en su vehículo personal o de empresa. Es la opinión de DD MAU que el uso de celular mientras se conduce es peligroso, por lo tanto, la empresa prohíbe el uso por empleado de cualquier celular, ya sea con manos o manos libres, para propósitos de negocio relacionados de cualquier manera a nuestra empresa mientras se conduce. Esta prohibición incluye recibir o hacer llamadas, mensajes de texto, navegar Internet, recibir o responder correos, revisar mensajes telefónicos, o cualquier otro propósito relacionado a tu empleo; el negocio; nuestros clientes; nuestros vendedores; actividades voluntarias, reuniones o responsabilidades cívicas realizadas para o atendidas en nombre de la empresa; o cualquier otra actividad relacionada con la empresa no nombrada aquí mientras se conduce. Cuando el uso del celular es necesario, el empleado debe estacionar el vehículo de manera consistente con los estándares de seguridad de tráfico antes de hacer o contestar llamadas.

Celulares en el Restaurante - Personal
A los empleados no gerenciales se les prohíbe el uso de celular mientras están en el trabajo. Esta prohibición incluye recibir o hacer llamadas, mensajes de texto, escuchar música, navegar Internet, recibir o responder correos o revisar mensajes telefónicos. Las posiciones reconocidas de nivel personal para las cuales el uso de celular está prohibido para DD MAU son:
 - Trabajadores de cocina
 - Meseros
 - Bartenders
 - Bussers
 - Anfitriones
 - Lavaplatos

Música en el Restaurante - Personal
La música puede tocarse a un mínimo antes de que el restaurante abra. Cuando la cocina cierre a las 7:45 PM la música de cocina puede tocarse. Para el personal del frente de la casa, no pueden ser visibles air pods o audífonos al ir al área de comedor. Habrá una advertencia y después de la segunda advertencia, los air pods o audífonos tendrán que guardarse. Perderás la habilidad de usarlos de nuevo.

Uso de Emergencia de Celular - Personal
DD MAU reconoce que muchos de sus empleados usan un celular como medio de notificación de emergencia por familia, escuelas, hospitales y otras personas u organizaciones para las cuales el contacto de emergencia es necesario. El uso limitado de emergencia de celulares se permite bajo las siguientes condiciones:
 1. Los empleados deben obtener permiso de la gerencia antes de usar.
 2. Los celulares deben estar en modo solo de vibración.

Violación de Política Es Causa de Acción Disciplinaria
Los empleados que violen esta política estarán sujetos a acción disciplinaria, hasta e incluyendo la terminación del empleo.

RECIBO DEL MANUAL Y DECLARACION DE POLITICA

Este Manual del Empleado no constituye un contrato de empleo ya sea en todo o en parte. DD MAU se reserva el derecho de agregar, eliminar o cambiar cualquier porción del Manual del Empleado con o sin aviso.

Reconozco recibo de, y he leído, el Manual del Empleado que describe mis beneficios y obligaciones como empleado de DD MAU. Entiendo los Estándares de Conducta y cada una de las reglas y regulaciones que se espera que siga, así como las políticas adicionales. Estoy de acuerdo en cumplirlas.

Se espera que todos los empleados conformen su conducta a las reglas y regulaciones establecidas en este manual, y entiendan que son empleados a voluntad. Los contenidos de cualquier Manual del Empleado, incluyendo este, que pueda ser distribuido durante el curso de su empleo no se construirá como un contrato o de ninguna manera vinculante. La Compañía se reserva el derecho de cambiar, a su discreción, los contenidos de este manual.

DECLARACION DE POLITICA
Este manual es una guía general y las provisiones de este manual no constituyen un acuerdo de empleo (contrato) o una garantía de empleo continuo. Simplemente está destinado a delinear los beneficios y requisitos de trabajo para todos los empleados. Se entiende además que DD MAU se reserva el derecho de cambiar las provisiones en este manual en cualquier momento. Es la política de DD MAU que el empleo y compensación de cualquier empleado es a voluntad y puede ser terminado con o sin causa, en cualquier momento, a opción del empleado o a opción de la Compañía.`,
        },
    },
    tip_credit: {
        en: {
            title: 'DD Mau Wage and Tip Pool Notice',
            body: `WAGE AND TIP POOL NOTICE

This notice explains how your pay works at DD Mau. Read it carefully and sign below to acknowledge you understand.

YOUR WAGE
DD Mau pays you a direct cash wage at or above the full Missouri minimum wage. We do NOT take a "tip credit." Your hourly wage is stated in your offer letter and on your paycheck stub.

THE TIP POOL
DD Mau operates a mandatory tip pool that includes both front-of-house (FOH) and back-of-house (BOH) staff. Federal law (FLSA, as amended by the 2018 Consolidated Appropriations Act and the 2020 DOL final rule) allows an employer that pays full minimum wage to require a tip pool that includes traditionally non-tipped employees such as cooks and dishwashers. Owners, managers, and supervisors are excluded from the pool, as required by federal law.

HOW POOL SHARES ARE CALCULATED
 - All tips received during a pay period (cash and credit/debit card) are pooled together.
 - 50% of the total pool is allocated to the FOH share.
 - 50% of the total pool is allocated to the BOH share.
 - The FOH share is divided by the total FOH hours worked during that pay period to produce an FOH dollars-per-hour rate.
 - The BOH share is divided by the total BOH hours worked during that pay period to produce a BOH dollars-per-hour rate.
 - Your tip payment for the period = your hours worked on your side x that side's dollars-per-hour rate.

EXAMPLE
If during one pay period the total tip pool is $2,000, then FOH gets $1,000 and BOH gets $1,000. If total FOH hours that period were 100, the FOH rate is $10/hr; an FOH employee who worked 30 hours would earn $300 in tip payment. The same math runs separately for BOH.

CREDIT/DEBIT CARD TIPS
Tips left on cards are paid out in the next paycheck. The processing fee charged by the card network on the tip portion may be deducted, as allowed by law.

TAXES
All tip income is taxable. DD Mau withholds applicable federal, state, FICA, and Medicare taxes from reported tips. You are responsible for reporting your tip income accurately.

OVERTIME
If you work more than 40 hours in a workweek, overtime is paid at 1.5 times your regular rate (which is at least the full minimum wage, since we do not take a tip credit).

NO CONFISCATION OR DIVERSION
DD Mau will not keep any portion of your tips for purposes other than the tip pool described here. Owners, managers, and supervisors do not receive tip pool distributions.

CHANGES TO THIS POLICY
DD Mau may update this tip pool policy in the future. Any change will be communicated in writing and you will receive an updated notice to acknowledge.

YOUR RIGHTS
If you believe tips are being mishandled, talk to a manager or owner.

ACKNOWLEDGMENT
I have read this notice. I understand DD Mau pays me full Missouri minimum wage or above and does not take a tip credit. I understand the mandatory 50/50 FOH/BOH tip pool and how my share is calculated. I understand owners, managers, and supervisors are excluded from the pool.`,
        },
        es: {
            title: 'Aviso de Salario y Fondo Común de Propinas de DD Mau',
            body: `AVISO DE SALARIO Y FONDO COMUN DE PROPINAS

Este aviso explica cómo funciona tu pago en DD Mau. Léelo con cuidado y firma abajo para confirmar que entiendes.

TU SALARIO
DD Mau te paga un salario en efectivo igual o superior al salario mínimo completo de Missouri. NO tomamos un "crédito por propinas". Tu salario por hora aparece en tu carta de oferta y en el talón de tu cheque.

EL FONDO COMUN DE PROPINAS
DD Mau opera un fondo común de propinas obligatorio que incluye tanto al personal del frente de la casa (FOH) como al de la cocina (BOH). La ley federal (FLSA, modificada por la Ley de Asignaciones Consolidadas de 2018 y la regla final del DOL de 2020) permite que un empleador que paga el salario mínimo completo exija un fondo común de propinas que incluya a empleados que tradicionalmente no reciben propinas, como cocineros y lavaplatos. Los dueños, gerentes y supervisores están excluidos del fondo, como lo exige la ley federal.

COMO SE CALCULAN LAS PORCIONES DEL FONDO
 - Todas las propinas recibidas durante un período de pago (efectivo y tarjeta de crédito/débito) se juntan.
 - 50% del fondo total se asigna a la porción FOH.
 - 50% del fondo total se asigna a la porción BOH.
 - La porción FOH se divide entre el total de horas FOH trabajadas durante ese período para producir una tasa FOH de dólares por hora.
 - La porción BOH se divide entre el total de horas BOH trabajadas durante ese período para producir una tasa BOH de dólares por hora.
 - Tu pago de propinas del período = tus horas trabajadas en tu lado x la tasa de dólares por hora de ese lado.

EJEMPLO
Si durante un período el fondo total de propinas es $2,000, entonces FOH recibe $1,000 y BOH recibe $1,000. Si el total de horas FOH ese período fue 100, la tasa FOH es $10/hr; un empleado FOH que trabajó 30 horas ganaría $300 en propinas. La misma matemática se aplica por separado a BOH.

PROPINAS DE TARJETA DE CREDITO/DEBITO
Las propinas dejadas en tarjetas se pagan en el siguiente cheque. La tarifa de procesamiento cobrada por la red de tarjetas sobre la porción de propina puede deducirse, según lo permite la ley.

IMPUESTOS
Todo ingreso por propinas es gravable. DD Mau retiene los impuestos federales, estatales, FICA y Medicare aplicables sobre las propinas reportadas. Tú eres responsable de reportar tu ingreso por propinas con exactitud.

HORAS EXTRA
Si trabajas más de 40 horas en una semana laboral, las horas extra se pagan a 1.5 veces tu tasa regular (que es al menos el salario mínimo completo, ya que no tomamos un crédito por propinas).

NO CONFISCACION NI DESVIO
DD Mau no se quedará con ninguna porción de tus propinas para propósitos distintos al fondo común descrito aquí. Los dueños, gerentes y supervisores no reciben distribuciones del fondo común.

CAMBIOS A ESTA POLITICA
DD Mau puede actualizar esta política de fondo común de propinas en el futuro. Cualquier cambio será comunicado por escrito y recibirás un aviso actualizado para reconocer.

TUS DERECHOS
Si crees que las propinas se están manejando mal, habla con un gerente o dueño.

RECONOCIMIENTO
He leído este aviso. Entiendo que DD Mau me paga el salario mínimo completo de Missouri o más y no toma un crédito por propinas. Entiendo el fondo común de propinas obligatorio 50/50 FOH/BOH y cómo se calcula mi porción. Entiendo que los dueños, gerentes y supervisores están excluidos del fondo.`,
        },
    },
};

// Workers' comp policy was removed 2026-05-13 per Andrew. Coverage of
// the Missouri workers' comp disclosure requirement now lives in:
//   1. The WORKER'S COMPENSATION subsection inside the handbook (which
//      hires sign via the handbook_ack onboarding doc), and
//   2. The official MO workers' comp poster required at each restaurant
//      location.
// Restore from git history (commit before 2026-05-13) if you ever want
// the standalone signed acknowledgment back.
