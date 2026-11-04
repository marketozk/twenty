export const findPersonByPrimaryOrAdditionalEmail = <
  TPerson extends {
    emails?: {
      primaryEmail?: string | null;
      additionalEmails?: string[] | null;
    } | null;
  },
>({
  people,
  email,
}: {
  people: TPerson[];
  email: string;
}): TPerson | undefined => {
  const lowercaseEmail = email.toLowerCase();

  const personWithPrimaryEmail = people.find(
    (person) => person.emails?.primaryEmail?.toLowerCase() === lowercaseEmail,
  );

  if (personWithPrimaryEmail) {
    return personWithPrimaryEmail;
  }

  const personWithAdditionalEmail = people.find((person) => {
    const additionalEmails = person.emails?.additionalEmails;

    if (!Array.isArray(additionalEmails)) {
      return false;
    }

    return additionalEmails.some(
      (additionalEmail) => additionalEmail.toLowerCase() === lowercaseEmail,
    );
  });

  return personWithAdditionalEmail;
};
