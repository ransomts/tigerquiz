class User < ApplicationRecord
  ROLES = %w[instructor admin].freeze

  has_many :quizzes, dependent: :destroy
  has_many :rosters, dependent: :destroy
  has_many :games, dependent: :destroy

  validates :eppn, presence: true, uniqueness: true
  validates :role, inclusion: { in: ROLES }

  def admin? = role == "admin"

  def name = display_name.presence || eppn
end
