const bcrypt = require("bcrypt");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const email = "owner@test.com";
  const password = "NewPassword123!";
  const hash = await bcrypt.hash(password, 10);

  const owner = await prisma.owner.update({
    where: { email },
    data: {
      password: hash,
      staff: {
        update: {
          emailVerifiedAt: new Date()
        }
      }
    },
    include: { staff: true }
  });

  console.log("Reset owner login:");
  console.log("Email:", owner.email);
  console.log("Password:", password);
  console.log("Verified:", owner.staff.emailVerifiedAt);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
