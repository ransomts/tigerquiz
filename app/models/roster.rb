# A class list: students who may join a game, matched by name or id.
class Roster < ApplicationRecord
  belongs_to :user
  has_many :games, dependent: :nullify

  validates :slug, presence: true, format: { with: Quiz::SLUG, message: "must be letters, digits, dash or underscore" },
                   uniqueness: { scope: :user_id }
  validates :title, presence: true
  validate { errors.add(:students, "must include at least one student") if students.blank? }

  scope :ordered, -> { order(Arel.sql("LOWER(title)")) }

  def summary
    { "id" => slug, "title" => title, "count" => students.length }
  end

  # The document the editor reads and writes.
  def document
    { "title" => title, "students" => students }
  end

  def playable
    Tigerquiz::RosterDocument.load(document, slug)
  end
end
