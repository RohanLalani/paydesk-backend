const bcrypt = require("bcrypt");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const role = process.argv[2];      // owner, partner, manager, employee
const email = process.argv[3];
const newPassword = process.argv[4];

const modelMap = {
  owner: prisma.owner,
  partner: prisma.partner,
  manager: prisma.manager,
  employee: prisma.employee,
};

async function main() {
  if (!modelMap[role]) {
    throw new Error("Role must be one of: owner, partner, manager, employee");
  }

  if (!email || !newPassword) {
    throw new Error("Usage: node reset-password.js <role> <email> <newPassword>");
  }

  const hash = await bcrypt.hash(newPassword, 10);

  const account = await modelMap[role].update({
    where: { email },
    data: { password: hash },
    include: { staff: true },
  });

  console.log("Password reset successful");
  console.log("Role:", role);
  console.log("Email:", account.email);
  console.log("Verified:", account.staff.emailVerifiedAt);
}

main()
  .catch((error) => {
    console.error("Reset failed:", error.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
